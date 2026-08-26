import { invoke } from '@tauri-apps/api/core'
import { parseReviewCheckpoint, type ReviewCheckpoint } from '../../core/ai/techReview'
import type { AgentType } from '../../core/ai/config'

// The shape the shared Rust store returns (snake_case, as serialized there).
interface StoredCheckpoint {
  content: string
  commit?: string | null
  branch?: string | null
  session_id?: string | null
  session_agent?: string | null
}

// Reads a saved review from the store shared with the daemon and the CLI,
// falling back to the browser copy this app used to keep on its own so
// reviews saved before the move are still there.
export async function loadReviewCheckpoint(repoPath: string, branch: string, localRaw: string | null): Promise<ReviewCheckpoint | null> {
  const stored = await invoke<StoredCheckpoint | null>('review_checkpoint_get', { cwd: repoPath, base: branch }).catch(() => null)
  if (stored?.content) {
    return {
      content: stored.content,
      commit: stored.commit ?? '',
      branch: stored.branch ?? branch,
      sessionId: stored.session_id ?? null,
      sessionAgent: (stored.session_agent ?? null) as AgentType | null,
    }
  }
  return parseReviewCheckpoint(localRaw)
}
