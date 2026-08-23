import { invoke } from '@tauri-apps/api/core'

/**
 * Builds the exact resume command for one of the known agent CLIs, verifying
 * the session still exists on disk before using --resume to avoid
 * "No conversation found" errors. Unrecognized commands pass through unchanged.
 */
export async function buildResumeCmd(cmd: string, cwd: string, sessionId?: string): Promise<string> {
  if (cmd === 'claude') {
    if (!sessionId) return 'claude'
    const exists = await invoke<boolean>('agent_claude_session_exists', { cwd, sessionId }).catch(() => false)
    return exists ? `claude --resume ${sessionId}` : 'claude'
  }
  if (cmd === 'opencode') return sessionId ? `opencode --session ${sessionId}` : 'opencode'
  if (cmd === 'codex') {
    if (!sessionId) return 'codex'
    // Codex only writes the rollout on the first message: a session captured at
    // launch but closed before any turn was never saved. Verify it exists before
    // resuming, else `codex resume <id>` fails hard with "No saved session found".
    const exists = await invoke<boolean>('agent_codex_session_exists', { sessionId }).catch(() => false)
    if (!exists) return 'codex'
    // Clear stale thread-writer lock so codex doesn't reject with
    // "already has an active writer" when the previous PTY was killed externally.
    await invoke('agent_codex_clear_lock', { sessionId }).catch(() => {})
    return `codex resume ${sessionId}`
  }
  return cmd
}
