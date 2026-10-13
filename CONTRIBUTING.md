# Contributing

Issues and pull requests are welcome.

- Run `npm test` (Node 22.13+). New behaviour needs a test; anything touching `src/publisher.js` must keep the "never publishes twice" tests green.
- Keep it dependency-free at runtime and small: this project is meant to be readable in one sitting.
- Don't commit tokens, account ids or real captions. Use the placeholders in `wrangler.jsonc` and `examples/`.
- Notification backends (Slack, Discord, e-mail) and an Instagram-Login (non-Facebook) auth path are good first contributions.
