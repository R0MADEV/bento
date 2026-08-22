import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { npmRunInvocation } from './lib/crossPlatformProcess.mjs'

const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
const override = {
  productName: 'bento-e2e',
  identifier: 'com.romadev.bento.e2e',
  app: {
    windows: [{
      label: 'main',
      title: 'Bento E2E',
      width: 1200,
      height: 800,
      resizable: true,
      dragDropEnabled: false,
      titleBarStyle: 'Overlay',
      hiddenTitle: true,
      // Windows/Linux use a separate directory. macOS 14+ uses the separate
      // WKWebsiteDataStore identifier assigned as a typed array in main.rs.
      dataDirectory: 'bento-e2e',
    }],
  },
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// This calls `cargo build` directly (skipping `tauri build`'s beforeBuildCommand
// hook), so tauri-build's externalBin validation needs the sidecar staged by hand.
run(process.execPath, ['scripts/build-daemon-sidecar.mjs'])

const npmBuild = npmRunInvocation('build')
run(npmBuild.command, npmBuild.args)
run(cargo, ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--features', 'e2e'], {
  ...process.env,
  TAURI_CONFIG: JSON.stringify(override),
})

const executable = resolve('src-tauri', 'target', 'debug', process.platform === 'win32' ? 'bento.exe' : 'bento')
console.log(`Isolated Bento E2E binary: ${executable}`)
