import { spawnSync } from 'node:child_process'

function run(command, args, capture = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout?.trim() ?? ''
}

function attempt(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe' })
}

const branch = run('git', ['branch', '--show-current'], true)
if (!branch) throw new Error('ci:remote requires a checked-out branch')

const pullRequest = attempt('gh', ['pr', 'view', '--json', 'number', '--jq', '.number'])
if (pullRequest.status === 0 && pullRequest.stdout.trim()) {
  console.log(`Watching remote CI for PR #${pullRequest.stdout.trim()} (${branch}).`)
  run('gh', ['pr', 'checks', '--watch'])
} else {
  run('gh', ['workflow', 'run', 'build.yml', '--ref', branch])
  console.log(`Remote CI requested for ${branch}.`)
  console.log(`Follow it with: gh run list --workflow build.yml --branch ${branch}`)
}
