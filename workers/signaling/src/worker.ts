import {
  answerKey,
  appendIceCandidate,
  iceCandidatesSince,
  iceKey,
  isValidPairingCode,
  offerKey,
  PAIRING_TTL_SECONDS,
} from './pairing'

interface KVNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

interface Env {
  PAIRING: KVNamespace
}

type RouteKind = 'offer' | 'answer' | 'ice'

function parseRoute(pathname: string): { kind: RouteKind; code: string } | null {
  const match = pathname.match(/^\/(offer|answer|ice)\/([^/]+)$/)
  if (!match) return null
  return { kind: match[1] as RouteKind, code: match[2] }
}

// Offer/answer are opaque SDP blobs: stored and returned as-is, never parsed here.
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

async function handleIce(request: Request, env: Env, code: string): Promise<Response> {
  const key = iceKey(code)
  if (request.method === 'POST') {
    const { candidate } = (await request.json()) as { candidate: string }
    const existing = JSON.parse((await env.PAIRING.get(key)) ?? '[]') as string[]
    const updated = appendIceCandidate(existing, candidate)
    await env.PAIRING.put(key, JSON.stringify(updated), { expirationTtl: PAIRING_TTL_SECONDS })
    return new Response(null, { status: 204 })
  }
  if (request.method === 'GET') {
    const since = Number(new URL(request.url).searchParams.get('since') ?? '0')
    const existing = JSON.parse((await env.PAIRING.get(key)) ?? '[]') as string[]
    return Response.json(iceCandidatesSince(existing, since))
  }
  return new Response('method not allowed', { status: 405 })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const route = parseRoute(new URL(request.url).pathname)
    if (!route) return new Response('not found', { status: 404 })
    if (!isValidPairingCode(route.code)) return new Response('invalid pairing code', { status: 400 })

    if (route.kind === 'offer') return handleOfferOrAnswer(request, env, offerKey(route.code))
    if (route.kind === 'answer') return handleOfferOrAnswer(request, env, answerKey(route.code))
    return handleIce(request, env, route.code)
  },
}
