# instagram-scheduler-worker

Schedule Instagram posts (images, carousels, reels) from a queue that lives on **Cloudflare Workers + D1 + R2**.
No server to run, no monthly fee for a small account, and it **never posts the same thing twice**.

[Leer en español →](README.es.md)

```
 you ── igs CLI / HTTP ──►  Worker  ──►  D1 (queue)            R2 (your JPEG/MP4 files)
                              │                                      ▲
                      cron every 5 min                               │ Instagram downloads the media from /media/…
                              ▼                                      │
                     Instagram Graph API  ◄──────────────────────────┘
                              │
                              └──► Telegram message when a post goes out (or fails)
```

## Why this exists

Built for and used in production by [Fundación Utopía Animal](https://utopianimal.org), an animal-welfare foundation in Medellín, Colombia, to post to its veterinary clinic and cat-shelter accounts.

Most schedulers are SaaS products that cost money per account and hold your tokens. This one is ~500 lines of source you can read in an
afternoon, runs inside your own Cloudflare account, and was built around one rule: **a post must go out exactly once**, even when
the network drops halfway through publishing.

## Features

- **Image, carousel (2–10 slides) and reel** posts, with up to 3 collaborators.
- **Multiple Instagram accounts** from one Worker.
- **Idempotent publishing.** The container id is stored the moment it exists. Before publishing, the container is checked; if Instagram
  already reports it as `PUBLISHED` (a previous run published and lost the answer), the post is only recorded. A publish that fails
  ambiguously keeps its container so the retry can find out what happened.
- **Retries** (up to 4, waiting 10/20/30 minutes). A post more than 6 hours overdue is never published on its own — stale content can hurt.
- **Overlap-safe cron** (atomic claim with a short lock).
- **Validation before queueing:** caption ≤ 2200 characters, ≤ 30 hashtags, https-only media, and the Worker checks that each media URL
  actually answers with `image/jpeg` / `video/mp4`, which is what Instagram will request.
- **Time zones done right:** schedule in local time (`"2026-10-19 19:00"`) with any IANA zone, DST included; times that don't exist
  (spring-forward gap) are rejected instead of silently shifted.
- **Notifications** on success and on every failure (Telegram; swap `src/notify.js` for Slack/Discord/e-mail).
- **Dry run:** `igs test <id>` makes Instagram build the container and tells you if it accepts it, without publishing.
- **Zero runtime dependencies.** The test suite runs on plain `node --test`, with real SQL (in-memory SQLite) standing in for D1.

Not supported (by design or by API): Stories, first comments, tagging users in the image, scheduling from the Instagram app.

## Requirements

- A Cloudflare account (the free plan is enough for a few posts a day) and `wrangler`.
- An Instagram **Business or Creator** account linked to a **Facebook Page**.
- A Meta developer app with a token that can publish. The permissions you normally need are `instagram_basic`,
  `instagram_content_publish`, `pages_show_list` and `pages_read_engagement`. Meta changes this over time — check the
  [Content Publishing docs](https://developers.facebook.com/docs/instagram-platform/content-publishing). A **system-user token**
  does not expire, which is what you want for a scheduler. If you only publish to accounts you administer, your app can stay in
  development mode.

## Setup (about 10 minutes)

```bash
git clone https://github.com/federicogmz/instagram-scheduler-worker && cd instagram-scheduler-worker
npm install

npx wrangler d1 create instagram-scheduler            # copy the database_id into wrangler.jsonc
npx wrangler r2 bucket create instagram-scheduler-media
```

Edit `wrangler.jsonc`:

| Variable | Meaning |
|---|---|
| `TIMEZONE` | IANA zone used to read `scheduled_local` and to print times, e.g. `America/Bogota`, `Europe/Madrid` |
| `ACCOUNTS` | JSON object, one entry per account: `{"main":{"page_id":"…","ig_id":"…","label":"@handle"}}` |
| `NOTIFY_LANG` | `en` (default) or `es`: language of the Telegram notifications |
| `GRAPH_VERSION` | Graph API version (default `v21.0`) |

Set the secrets (they are never stored in the repo):

```bash
npx wrangler secret put META_ACCESS_TOKEN     # Meta token that can publish
npx wrangler secret put PUBLISH_SECRET        # long random string; protects every admin endpoint
npx wrangler secret put TELEGRAM_BOT_TOKEN    # optional
npx wrangler secret put TELEGRAM_CHAT_ID      # optional
npx wrangler deploy
```

The table is created automatically on the first request. Then point the CLI at your Worker:

```bash
export IGS_URL=https://instagram-scheduler.<your-subdomain>.workers.dev
export IGS_SECRET=<the PUBLISH_SECRET you chose>
```

## Daily use

```bash
node cli/igs.mjs upload photo.png --prefix 2026-10     # converts PNG→JPEG if needed, prints the public URL
# put that URL in a post file (see examples/post.json), then:
node cli/igs.mjs schedule examples/post.json
node cli/igs.mjs test launch-announcement              # dry run: does Instagram accept it?
node cli/igs.mjs queue
```

`igs` also offers `show`, `publish` (now), `cancel` and `retry <id> [--at "2026-10-19 19:00"]`. Everything the CLI does is a plain HTTP call, so you can use
`curl` or call it from CI.

### Post format

```json
{
  "id": "launch-announcement",
  "account": "main",
  "title": "Launch announcement",
  "type": "image",
  "media": ["https://…/media/2026-10/launch.jpg"],
  "caption": "We are live! #launch",
  "scheduled_local": "2026-10-19 19:00",
  "collaborators": []
}
```

Use `scheduled_utc` (ISO 8601) instead of `scheduled_local` if you prefer. Media may be hosted by the Worker (`igs upload`) or anywhere
public over https. Instagram only accepts JPEG images and MP4 video.

### HTTP API

Admin routes need the header `x-secret: <PUBLISH_SECRET>`.

| Method | Path | |
|---|---|---|
| GET | `/status` | public; counts per status only |
| GET | `/media/<path>` | public; Instagram downloads files from here |
| POST | `/media?name=<path>[&overwrite=1]` | upload a JPEG/MP4 |
| GET / POST | `/queue` | list / schedule |
| GET / DELETE | `/queue/<id>` | show / cancel |
| POST | `/queue/<id>/retry` | re-queue a failed or cancelled post; optional body `{"scheduled_local": "…"}` to pick a new time (a post too late to go out on its own is rescheduled for now) |
| POST | `/publish?post=<id>[&dry_run=1]` | publish now / test only |
| POST | `/notify-test` | send a test notification |

Statuses: `pending → processing → published`, or `failed` / `cancelled`.

## How the "never twice" guarantee works

1. The cron claims a due post with an atomic `UPDATE … WHERE lock_until IS NULL OR lock_until < now`.
2. It creates the Instagram container and **saves `creation_id` before doing anything else**.
3. It polls the container. `FINISHED` → publish. `PUBLISHED` → already out, just record it. `ERROR`/`EXPIRED` → discard and retry.
4. If `media_publish` throws (timeout, connection reset), the container is **kept**; next run goes to step 3 and discovers the truth.

The tests in `test/publisher.test.js` cover each of these paths.

## Security notes

- Keep `PUBLISH_SECRET` long and random. It is compared in constant time and only accepted in a header.
- `/media/*` is public on purpose (Instagram must fetch the files). Don't upload anything you wouldn't post.
- `/status` exposes counts only, never captions or titles.
- Rotate `META_ACCESS_TOKEN` if it leaks. See [SECURITY.md](SECURITY.md) to report vulnerabilities.

## Development

```bash
npm test                      # Node 22.13+ (uses node:sqlite for the D1 stand-in)
cp .dev.vars.example .dev.vars && npx wrangler dev
```

## Limitations worth knowing

- Meta enforces its own daily publishing limit per account and may change API behaviour; the Worker reports whatever error Meta returns.
- Reels are processed asynchronously by Instagram, so they take two cron runs (≈5–10 min) after their time.
- Cloudflare cron has minute granularity; a post goes out within ~5 minutes of its scheduled time.

## Disclaimer

Not affiliated with or endorsed by Meta, Instagram or Cloudflare. "Instagram" is a trademark of Meta Platforms, Inc.
Use of the Instagram API is subject to Meta's terms and policies.

## License

[MIT](LICENSE)
