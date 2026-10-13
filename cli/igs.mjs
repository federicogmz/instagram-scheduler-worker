#!/usr/bin/env node
// igs — command line client for instagram-scheduler-worker. Zero dependencies (Node 18+).
//
//   export IGS_URL=https://instagram-scheduler.<you>.workers.dev
//   export IGS_SECRET=<your PUBLISH_SECRET>
//
//   igs upload <file.jpg|png|mp4>... [--prefix 2026-10] [--overwrite]   upload to R2, print the public URL
//   igs schedule <post.json>                                            add a post to the queue (validated server-side)
//   igs queue [status]                                                  list posts (pending|processing|published|failed|cancelled)
//   igs show <id>
//   igs test <id>                                                       dry run: Instagram builds the container, nothing is published
//   igs publish <id>                                                    publish right now
//   igs cancel <id>
//   igs retry <id> [--at "2026-10-19 19:00"]                           re-queue a failed/cancelled post (optionally at a new local time)
//
// post.json: { "id", "account", "title", "type": "image|carousel|reel", "media": ["https://…"], "caption",
//              "scheduled_local": "2026-10-19 19:00", "collaborators": ["username"] }
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';

const { IGS_URL, IGS_SECRET } = process.env;
const [cmd, ...args] = process.argv.slice(2);
const HELP = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');

if (!cmd || cmd === '--help' || cmd === '-h') { console.log(HELP); process.exit(0); }
if (!IGS_URL || !IGS_SECRET) { console.error('Set IGS_URL and IGS_SECRET (see --help).'); process.exit(2); }

const api = async (path, { method = 'GET', body, headers = {} } = {}) => {
  const r = await fetch(IGS_URL.replace(/\/$/, '') + path, { method, body, headers: { 'x-secret': IGS_SECRET, ...headers } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`HTTP ${r.status}`, JSON.stringify(j, null, 2)); process.exit(1); }
  return j;
};
const enc = encodeURIComponent;
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
const flag = (name, takesValue = true) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return null;
  if (!takesValue) { args.splice(i, 1); return true; }
  const v = args[i + 1]; args.splice(i, 2); return v;
};

/** Instagram rejects PNG/WebP: convert to JPEG with whatever is installed (macOS sips, or ImageMagick). */
function toJpeg(input, dir) {
  const out = join(dir, basename(input, extname(input)) + '.jpg');
  const attempts = [
    ['sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', input, '--out', out]],
    ['magick', [input, '-quality', '92', out]],
    ['convert', [input, '-quality', '92', out]],
  ];
  for (const [bin, a] of attempts) { try { execFileSync(bin, a, { stdio: 'ignore' }); return out; } catch { /* try the next tool */ } }
  console.error(`Cannot convert ${input} to JPEG: install ImageMagick (or use macOS), or convert it yourself.`);
  process.exit(1);
}

switch (cmd) {
  case 'upload': {
    const prefix = flag('prefix') || new Date().toISOString().slice(0, 7);
    const overwrite = flag('overwrite', false);
    const dir = mkdtempSync(join(tmpdir(), 'igs-'));
    for (const file of args) {
      let path = file, ext = extname(file).toLowerCase();
      if (['.png', '.webp', '.heic'].includes(ext)) { path = toJpeg(file, dir); ext = '.jpg'; }
      if (ext === '.jpeg') ext = '.jpg';
      if (!['.jpg', '.mp4'].includes(ext)) { console.error('Unsupported format (use JPG, PNG, WebP, HEIC or MP4):', file); process.exit(1); }
      const name = `${prefix}/${slug(basename(file, extname(file)))}${ext}`;
      const r = await api(`/media?name=${enc(name)}${overwrite ? '&overwrite=1' : ''}`, {
        method: 'POST', body: readFileSync(path), headers: { 'Content-Type': ext === '.mp4' ? 'video/mp4' : 'image/jpeg' },
      });
      console.log(`${r.url}  (${(r.bytes / 1024).toFixed(0)} KB)`);
    }
    break;
  }
  case 'schedule': {
    const r = await api('/queue', { method: 'POST', body: readFileSync(args[0]), headers: { 'Content-Type': 'application/json' } });
    console.log(`✅ scheduled "${r.id}" for ${r.scheduled_local} (${r.timezone})`);
    break;
  }
  case 'queue': {
    const r = await api('/queue' + (args[0] ? `?status=${enc(args[0])}` : ''));
    for (const p of r.posts) {
      console.log(`${p.scheduled_local}  ${p.account.padEnd(8)} ${p.type.padEnd(8)} ${p.status.padEnd(10)} ${p.id}${p.error ? '  ⚠ ' + p.error.slice(0, 90) : ''}${p.permalink ? '  ' + p.permalink : ''}`);
    }
    break;
  }
  case 'show': console.log(JSON.stringify((await api(`/queue/${enc(args[0])}`)).post, null, 2)); break;
  case 'test': console.log(JSON.stringify(await api(`/publish?post=${enc(args[0])}&dry_run=1`, { method: 'POST' }), null, 2)); break;
  case 'publish': console.log(JSON.stringify(await api(`/publish?post=${enc(args[0])}`, { method: 'POST' }), null, 2)); break;
  case 'cancel': console.log(JSON.stringify(await api(`/queue/${enc(args[0])}`, { method: 'DELETE' }))); break;
  case 'retry': {
    const at = flag('at');
    console.log(JSON.stringify(await api(`/queue/${enc(args[0])}/retry`, {
      method: 'POST', ...(at ? { body: JSON.stringify({ scheduled_local: at }), headers: { 'Content-Type': 'application/json' } } : {}),
    })));
    break;
  }
  default: console.error(`Unknown command: ${cmd}\n`); console.log(HELP); process.exit(2);
}
