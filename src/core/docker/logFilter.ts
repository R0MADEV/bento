// Heuristic "is this an error/warning line?" tuned on real logs. Word boundaries
// (\b) avoid substring false positives ("terror" ≠ error), and because brackets,
// quotes and = are non-word chars, the same regex also catches structured logs:
// [ERROR], "level":"error", level=warn, etc. We match on the message content —
// NOT the stream — because many apps (e.g. MCP servers) send all logs to stderr.
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
  return ERROR_RE.test(line)
}

export function errorLines(text: string): string[] {
  return text.split('\n').filter(isErrorLine)
}
