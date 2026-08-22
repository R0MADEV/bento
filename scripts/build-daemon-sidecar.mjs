// Builds bento-daemon in release mode and stages it as the Tauri sidecar
// binary (`bundle.externalBin` in tauri.conf.json) so packaged builds ship a
// working daemon — without this, the installed app has no bento-daemon at
// all and every terminal/agent/remote-control feature just hangs.
import { spawnSync } from 'node:child_process'
import { mkdirSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'

const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo'

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function hostTriple() {
  const result = spawnSync('rustc', ['-vV'], { encoding: 'utf8' })
  const match = result.stdout.match(/^host: (\S+)$/m)
  if (!match) throw new Error('could not determine host triple from `rustc -vV`')
  return match[1]
}

run(cargo, ['build', '--release', '--manifest-path', 'daemon/Cargo.toml', '-p', 'bento-daemon'])

const ext = process.platform === 'win32' ? '.exe' : ''
const triple = hostTriple()
const src = resolve('daemon', 'target', 'release', `bento-daemon${ext}`)
const destDir = resolve('src-tauri', 'binaries')
const dest = resolve(destDir, `bento-daemon-${triple}${ext}`)

mkdirSync(destDir, { recursive: true })
copyFileSync(src, dest)
console.log(`Staged daemon sidecar: ${dest}`)
