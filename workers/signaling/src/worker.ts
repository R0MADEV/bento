import { answerKey, isValidPairingCode, offerKey, PAIRING_TTL_SECONDS } from './pairing'
import { PAIR_HTML, PAIR_JS } from './pairAssets'

interface KVNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

interface Env {
  PAIRING: KVNamespace
}

type RouteKind = 'offer' | 'answer'

function parseSignalingRoute(pathname: string): { kind: RouteKind; code: string } | null {
  const match = pathname.match(/^\/(offer|answer)\/([^/]+)$/)
  if (!match) return null
  return { kind: match[1] as RouteKind, code: match[2] }
}

// Offer/answer are opaque SDP blobs: stored and returned as-is, never parsed here.
// ICE is non-trickle (gather-then-send), so this is the only exchange needed —
// no separate candidate relay.
async function handleOfferOrAnswer(request: Request, env: Env, key: string): Promise<Response> {
  if (request.method === 'POST') {
    const body = await request.text()
    await env.PAIRING.put(key, body, { expirationTtl: PAIRING_TTL_SECONDS })
    return new Response(null, { status: 204 })
  }
  if (request.method === 'GET') {
    const value = await env.PAIRING.get(key)
    if (value === null) return new Response('not found', { status: 404 })
    return new Response(value)
  }
  return new Response('method not allowed', { status: 405 })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)

    if (pathname === '/' || pathname === '/pair') {
      return new Response(PAIR_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    if (pathname === '/pair.js') {
      return new Response(PAIR_JS, { headers: { 'content-type': 'application/javascript; charset=utf-8' } })
    }

    const route = parseSignalingRoute(pathname)
    if (!route) return new Response('not found', { status: 404 })
    if (!isValidPairingCode(route.code)) return new Response('invalid pairing code', { status: 400 })

    const key = route.kind === 'offer' ? offerKey(route.code) : answerKey(route.code)
    return handleOfferOrAnswer(request, env, key)
  },
}
