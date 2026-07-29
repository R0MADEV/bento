import { spawnSync } from 'node:child_process'

const result = spawnSync('git', ['status', '--porcelain', '--', 'src/generated/bindings'], { encoding: 'utf8' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
if (result.stdout.trim()) {
  console.error('Rust/TypeScript bindings are not up to date:')
  console.error(result.stdout.trim())
  console.error('Run npm run bindings:generate and commit src/generated/bindings.')
  process.exit(1)
}
