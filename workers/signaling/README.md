# bento-signaling

Signaling relay for Bento's WebRTC remote control (see [`../../WEBRTC_REMOTE.md`](../../WEBRTC_REMOTE.md)).
It only ever sees one SDP offer and one answer per pairing — no app traffic
goes through it, and nothing is stored past 5 minutes.

## Deploy your own (no terminal needed)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/R0MADEV/bento/tree/main/workers/signaling)

Click the button, log in with (or create) a free Cloudflare account, and
click deploy — Cloudflare creates its own copy of this folder in your
GitHub account and provisions everything it needs (including the KV
namespace) on its own. When it finishes, copy the `https://….workers.dev`
URL it gives you into Bento's "URL del Worker" field (panel Móvil →
Emparejar sin Tailscale).

## Deploy from the terminal instead

```bash
cd workers/signaling
cp wrangler.toml.example wrangler.toml
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` provisions the KV namespace on first run — no manual
`wrangler kv namespace create` step needed. `wrangler.toml` is gitignored:
once deployed it's tied to your Cloudflare account, not something to share.
