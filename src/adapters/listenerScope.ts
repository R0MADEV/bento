import { listen, type EventCallback } from '@tauri-apps/api/event'

// Tauri listeners owned by something that can go away (a panel, an agent
// slot). `listen()` resolves after an IPC round trip, so its owner may already
// be closed by then: such a late listener is dropped instead of leaking.
export function createListenerScope() {
  let closed = false
  const unlisteners: Array<() => void> = []
  return {
    /** Resolves once the listener is registered, so callers can wait for it. */
    listen<T>(event: string, handler: EventCallback<T>): Promise<void> {
      return listen<T>(event, handler)
        .then(unlisten => {
          if (closed) unlisten()
          else unlisteners.push(unlisten)
        })
        .catch(() => {})
    },
    close(): void {
      closed = true
      unlisteners.splice(0).forEach(unlisten => unlisten())
    },
  }
}
