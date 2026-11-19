import { invoke } from '@tauri-apps/api/core'

// The shell command that relaunches an agent, resuming its session when one is
// still on disk. The rules live in `bento_sessions::resume_line_for_shell`, the ones
// the daemon resumes with, so the app, the CLI and the phone agree. An agent
// those rules don't cover (Aider, Gemini…) just starts again by its name.
export async function buildResumeCmd(cmd: string, cwd: string, sessionId?: string, configDir?: string): Promise<string> {
  const line = await invoke<string | null>('agent_resume_line', { agent: cmd, cwd, sessionId, configDir }).catch(() => null)
  return line ?? cmd
}
