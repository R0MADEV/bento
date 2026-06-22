// Which singleton panel types the user has unlocked to allow multiple instances
// (e.g. allow more than one TV). Persisted globally; off by default.

const KEY = 'bento.panels.unlocked'
const EVENT = 'bento:panel-unlock'

function read(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

export function isUnlocked(type: string): boolean {
  return read().includes(type)
}

export function setUnlocked(type: string, on: boolean): void {
  const types = new Set(read())
  if (on) types.add(type)
  else types.delete(type)
  localStorage.setItem(KEY, JSON.stringify([...types]))
  window.dispatchEvent(new CustomEvent(EVENT, { detail: type }))
}

export function toggleUnlocked(type: string): boolean {
  const next = !isUnlocked(type)
  setUnlocked(type, next)
  return next
}

// Subscribe to unlock changes. Returns the unsubscribe function.
export function onUnlockChange(handler: () => void): () => void {
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}
