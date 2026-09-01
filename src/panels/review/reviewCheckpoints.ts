import { invoke } from '@tauri-apps/api/core'
import { parseReviewCheckpoint, type ReviewCheckpoint } from '../../core/ai/techReview'
import type { AgentType } from '../../core/ai/config'
import type { CheckpointMeta } from './reviewHistory'

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
//
// `runId` names one review of that branch. Without it the store answers with
// the newest, which is all this app could ask for before it could list them.
export async function loadReviewCheckpoint(repoPath: string, branch: string, localRaw: string | null, runId?: string | null): Promise<ReviewCheckpoint | null> {
  const stored = await invoke<StoredCheckpoint | null>('review_checkpoint_get', { cwd: repoPath, base: branch, runId: runId ?? null }).catch(() => null)
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

// Every review saved for this project, newest first — from the store the
// daemon and the CLI write to as well, so the ones run from the phone or the
// terminal are in the list too. A store that cannot be read is an empty
// history, not a broken panel.
export async function listReviewCheckpoints(repoPath: string): Promise<CheckpointMeta[]> {
  return await invoke<CheckpointMeta[]>('review_checkpoints_list', { cwd: repoPath }).catch(() => [])
}

// Removes one saved review. Naming the run is what makes this reach the file:
// without it only the runless entry was ever removed, and the review came back
// on the next listing.
export async function deleteReviewCheckpoint(repoPath: string, base: string, runId?: string | null): Promise<void> {
  await invoke('review_checkpoint_delete', { cwd: repoPath, base, runId: runId ?? null }).catch(() => {})
}
