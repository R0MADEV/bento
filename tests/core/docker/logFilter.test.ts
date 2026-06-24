import { describe, it, expect } from 'vitest'
import { isErrorLine, errorLines } from '../../../src/core/docker/logFilter'

describe('isErrorLine', () => {
  it('flags explicit levels and structured logs', () => {
    expect(isErrorLine('[ERROR] db down')).toBe(true)
    expect(isErrorLine('Error: config file not found at /x')).toBe(true)
    expect(isErrorLine('{"level":"error","msg":"x"}')).toBe(true)
    expect(isErrorLine('time=2024 level=warn msg=retry')).toBe(true)
    expect(isErrorLine('[signal-mcp] fatal:')).toBe(true)
    expect(isErrorLine('panic: runtime error')).toBe(true)
  })

  it('flags error verbs without the literal word "error" (real signal-mcp)', () => {
    expect(isErrorLine('[signal-mcp] run abc rejected:')).toBe(true)
    expect(isErrorLine('connection refused')).toBe(true)
    expect(isErrorLine('unable to connect to signal')).toBe(true)
    expect(isErrorLine('request timeout after 30s')).toBe(true)
  })

  it('does NOT flag normal lines (console.error used for info in MCP servers)', () => {
    expect(isErrorLine('[signal-mcp] project: myproj')).toBe(false)
    expect(isErrorLine('signal-mcp is already registered in ~/.claude.json')).toBe(false)
    expect(isErrorLine('Usage: signal-mcp install --config /path')).toBe(false)
    expect(isErrorLine('GET /health 200')).toBe(false)
  })

  it('avoids substring false positives', () => {
    expect(isErrorLine('terror movie at the mirror')).toBe(false)
  })

  it('respects an explicit log level over the message text', () => {
    // real traefik line: debug level, but the message mentions "error"
    expect(isErrorLine('time="..." level=debug msg="http: TLS handshake error from x"')).toBe(false)
    expect(isErrorLine('time="..." level=error msg="boom"')).toBe(true)
    expect(isErrorLine('{"level":"info","msg":"connection error code"}')).toBe(false)
    expect(isErrorLine('{"level":"error","msg":"x"}')).toBe(true)
    expect(isErrorLine('[DEBUG] error while parsing (ignored)')).toBe(false)
    // no declared level → fall back to keyword (postgres / keycloak style)
    expect(isErrorLine('2026-06-22 [1497] ERROR:  column "id" does not exist')).toBe(true)
    expect(isErrorLine('2026 ERROR [org.keycloak.events] something')).toBe(true)
  })
})

describe('errorLines', () => {
  it('keeps only the error lines', () => {
    const log = '[signal-mcp] project: x\n[signal-mcp] run 1 rejected:\nGET / 200\n[ERROR] boom'
    expect(errorLines(log)).toEqual(['[signal-mcp] run 1 rejected:', '[ERROR] boom'])
  })

  it('returns empty when there are no errors', () => {
    expect(errorLines('all good\nfine')).toEqual([])
  })

  it('keeps the stack trace / context that follows an error (real Vite case)', () => {
    const log = [
      'Node.js v25.9.0',
      'failed to load config from /opt/x/vite.config.ts',
      'error when starting dev server:',
      "Error: Cannot find module '../tokenizer/marker'",
      'Require stack:',
      '- /opt/x/split.js',
      '    at Module._resolveFilename (node:internal/modules/cjs/loader:1475:15)',
      'INFO server ready',
    ].join('\n')
    expect(errorLines(log)).toEqual([
      'failed to load config from /opt/x/vite.config.ts',
      'error when starting dev server:',
      "Error: Cannot find module '../tokenizer/marker'",
      'Require stack:',
      '- /opt/x/split.js',
      '    at Module._resolveFilename (node:internal/modules/cjs/loader:1475:15)',
    ])
  })
})
