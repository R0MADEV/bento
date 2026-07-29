#!/usr/bin/env node

import { generateTranscriptSummary } from './lib/transcriptSummary.mjs'

const payload = await new Promise(resolve => {
  let input = ''
  process.stdin.on('data', chunk => { input += chunk })
  process.stdin.on('end', () => { try { resolve(JSON.parse(input)) } catch { resolve({}) } })
})

const agent = String(payload.agent || '')
const cwd = String(payload.cwd || process.cwd())
const transcript = String(payload.transcript || '')

if (!['claude', 'codex'].includes(agent) || !transcript.trim()) process.exit(1)

const summary = await generateTranscriptSummary(agent, cwd, transcript)
process.stdout.write(summary)
