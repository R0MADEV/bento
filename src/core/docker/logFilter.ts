// "Is this an error/warning line?" tuned on real container logs.
//
// 1. If the line declares an explicit level (logfmt `level=debug`, JSON
//    `"level":"info"`, or a bracketed `[DEBUG]`), trust it — a debug line that
//    merely mentions "error" in its message is NOT an error (real traefik case).
// 2. Otherwise fall back to keyword matching with word boundaries (\b), which
//    avoids substring false positives ("terror") and, because brackets/quotes/=
//    are non-word chars, still catches `ERROR:` / `[ERROR]` style prefixes.
// We match on content, NOT the stream, since many apps (MCP servers) log
// everything to stderr.

const ERROR_LEVELS = new Set(['error', 'err', 'fatal', 'panic', 'critical', 'crit', 'severe', 'warn', 'warning', 'alert', 'emerg', 'emergency'])
const INFO_LEVELS = new Set(['debug', 'dbug', 'info', 'information', 'trace', 'notice', 'verbose', 'fine', 'finer', 'finest', 'log'])

function levelKind(level: string): 'error' | 'info' | null {
  const l = level.toLowerCase()
  if (ERROR_LEVELS.has(l)) return 'error'
  if (INFO_LEVELS.has(l)) return 'info'
  return null
}

// An explicit level from a structured log, or null if the line declares none.
function explicitLevel(line: string): 'error' | 'info' | null {
  const kv = line.match(/(?:^|[\s,{])["']?(?:level|lvl|severity|loglevel)["']?\s*[:=]\s*["']?([a-z]+)/i)
  if (kv) {
    const k = levelKind(kv[1])
    if (k) return k
  }
  const bracket = line.match(/\[([a-z]+)\]/i)
  if (bracket) {
    const k = levelKind(bracket[1])
    if (k) return k
  }
  return null
}

const ERROR_RE = new RegExp(
  '\\b(' +
    'error|errors|err|exception|exceptions|fatal|panic|panicked|critical|severe|' +
    'warn|warning|warnings|alert|emergency|' +
    'fail|failed|failure|fails|failing|' +
    'traceback|stacktrace|segfault|unhandled|crash|crashed|' +
    'denied|refused|rejected|timeout|unable|cannot|unreachable' +
  ')\\b',
  'i',
)

export function isErrorLine(line: string): boolean {
  const level = explicitLevel(line)
  if (level) return level === 'error'
  return ERROR_RE.test(line)
}

// Lines that belong to a preceding error: stack frames (indented, `at …`),
// require-stack bullets (`- /path`), and block headers — so the error keeps its
// trace/context instead of just the headline.
function isContinuation(line: string): boolean {
  return /^\s+/.test(line)
    || /^\s*at\s/i.test(line)
    || /^\s*-\s/.test(line)
    || /^(require stack|caused by|traceback|stack ?trace|\.\.\.)/i.test(line)
}

// Error lines plus the continuation block that follows each one.
export function errorLines(text: string): string[] {
  const out: string[] = []
  let inError = false
  for (const line of text.split('\n')) {
    if (isErrorLine(line)) {
      out.push(line)
      inError = true
    } else if (inError && isContinuation(line)) {
      out.push(line)
    } else {
      inError = false
    }
  }
  return out
}
