export const PAIRING_CODE_LENGTH = 6
export const PAIRING_TTL_SECONDS = 5 * 60

export function generatePairingCode(): string {
  const digits = crypto.getRandomValues(new Uint8Array(PAIRING_CODE_LENGTH))
  return Array.from(digits, d => d % 10).join('')
}

export function isValidPairingCode(code: string): boolean {
  return /^\d{6}$/.test(code)
}

export function offerKey(code: string): string {
  return `offer:${code}`
}

export function answerKey(code: string): string {
  return `answer:${code}`
}

export function iceKey(code: string): string {
  return `ice:${code}`
}

export function appendIceCandidate(existing: string[], candidate: string): string[] {
  return [...existing, candidate]
}

export function iceCandidatesSince(candidates: string[], since: number): { candidates: string[]; total: number } {
  return { candidates: candidates.slice(since), total: candidates.length }
}
