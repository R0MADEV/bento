// Tells the daemon how much terminal output xterm has already painted, so it
// pauses a flooding program instead of letting the backlog pile up here.
// Batched: one ack per chunk would double the IPC traffic. The batch must stay
// well under the daemon's low watermark (256K), or a paused terminal would
// never be told it can resume.

export const ACK_BATCH = 64 * 1024

export function createOutputAcks(send: (chars: number) => void, batch = ACK_BATCH) {
  let unsent = 0
  return {
    painted(chars: number): void {
      unsent += chars
      if (unsent < batch) return
      send(unsent)
      unsent = 0
    },
  }
}
