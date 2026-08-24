# bento-signaling

Signaling relay for Bento's WebRTC remote control (see [`../../WEBRTC_REMOTE.md`](../../WEBRTC_REMOTE.md)).
It only ever relays the SDP offer/answer for a pairing code — no app traffic
goes through it, and nothing is stored past the code's 24h lifetime.

## Deploy your own (no terminal needed)

> The button below points at `main` — it 404s until this feature branch is
> merged there (GitHub's deploy tool needs the target path to actually
> exist on that branch). The in-app link in Bento's Phone panel points at
> the feature branch instead, so it works right now for testing.

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
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` provisions the KV namespace on first run — no manual
`wrangler kv namespace create` step needed. It also rewrites `wrangler.toml`
with the id it created, tying that file to your Cloudflare account —
that's a local change, don't commit it back.
