export const PAIRING_CODE_LENGTH = 6
// A day, not just once: the code stays answerable the whole time (see
// run_offerer's loop in webrtc_bridge.rs), so scanning it once covers a full
// day of reconnects — accidental page reloads, Safari backgrounding the tab,
// closing and reopening the app — without generating a new one each time.
export const PAIRING_TTL_SECONDS = 24 * 60 * 60

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
