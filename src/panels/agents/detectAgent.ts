// Maps an agent CLI command to its display name, and detects which known agent
// a typed shell line launches. Kept as a pure module so it can be unit-tested
// without the terminal/DOM machinery of the panel.

// CLI command → display name for auto-detection.
export const KNOWN_AGENTS: Record<string, string> = {
  'claude':    'Claude Code',
  'opencode':  'OpenCode',
  'codex':     'Codex',
  'cursor':    'Cursor',
  'aider':     'Aider',
  'gemini':    'Gemini CLI',
  'continue':  'Continue',
  'cline':     'Cline',
  'goose':     'Goose',
}

// Runner prefixes to skip so `sudo claude` / `npx claude` still detect.
const CMD_PREFIXES = new Set(['sudo', 'npx', 'command', 'exec', 'time'])

// Extracts the agent CLI from a typed line: skips runner prefixes and resolves
// a full path to its basename (`/usr/local/bin/claude` → `claude`). Returns the
// canonical command key if it's a known agent, else undefined.
export function detectAgentCmd(line: string): string | undefined {
  const tokens = line.trim().toLowerCase().split(/\s+/)
  let i = 0
  while (i < tokens.length && CMD_PREFIXES.has(tokens[i])) i++
  const first = tokens[i]
  if (!first) return undefined
  const base = first.split('/').pop() || first
  return KNOWN_AGENTS[base] ? base : undefined
}

// The name + cmd a terminal's slot should have after `detected` is run in it.
// cmd ALWAYS follows the latest agent so it stays consistent with the session
// captured for that same agent — mixing a previous agent's cmd with a new
// agent's session id yields e.g. `opencode --session <codex-id>`. The display
// name only auto-updates while the slot still has its default name.
export function resolveAgentIdentity(
  currentName: string,
  defaultName: string,
  detected: string,
): { name: string; cmd: string } {
  const name = currentName === defaultName ? (KNOWN_AGENTS[detected] ?? currentName) : currentName
  return { name, cmd: detected }
}
