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
