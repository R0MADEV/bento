import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const app = process.env.BENTO_E2E_APP ?? resolve('src-tauri', 'target', 'debug', process.platform === 'win32' ? 'bento.exe' : 'bento')
const provider = process.env.BENTO_E2E_PROVIDER ?? 'embedded'
const embeddedPort = process.env.BENTO_E2E_PORT ?? '4445'
const driverUrl = process.env.BENTO_E2E_DRIVER_URL ?? `http://127.0.0.1:${provider === 'embedded' ? embeddedPort : '4444'}`
const root = mkdtempSync(join(tmpdir(), 'bento-tasks-e2e-'))
process.env.BENTO_E2E_CONFIG_DIR = join(root, 'config')
const driver = provider === 'external' && !process.env.BENTO_E2E_DRIVER_URL
  ? spawn(process.env.TAURI_DRIVER ?? 'tauri-driver', [], { stdio: 'inherit' }) : null
let appProcess = null
let appExit = null
const repo = join(root, 'repo espacio ñ')
const task = join(root, 'tarea unicode ñ')
const conflict = join(root, 'conflicto espacio ñ')
const remote = join(root, 'remote.git')
let sessionId = ''
let isolatedProfile = false

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
function startApp() {
  if (provider !== 'embedded') return
  appExit = null
  appProcess = spawn(app, [], { stdio: 'inherit', env: { ...process.env, TAURI_WEBDRIVER_PORT: embeddedPort } })
  appProcess.once('exit', (code, signal) => { appExit = { code, signal } })
}
async function stopApp() {
  if (!appProcess || appProcess.exitCode !== null) { appProcess = null; return }
  const stopped = new Promise(resolve => appProcess.once('exit', resolve))
  appProcess.kill('SIGTERM')
  const stoppedGracefully = await Promise.race([stopped.then(() => true), delay(5000).then(() => false)])
  if (!stoppedGracefully && appProcess.exitCode === null) {
    appProcess.kill('SIGKILL')
    await Promise.race([stopped, delay(2000)])
  }
  appProcess = null
}

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function fixture() {
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'e2e@bento.test')
  git(repo, 'config', 'user.name', 'Bento E2E')
  writeFileSync(join(repo, 'shared.txt'), 'base\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  spawnSync('git', ['init', '--bare', '-q', remote])
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-qu', 'origin', 'main')

  git(repo, 'worktree', 'add', '-qb', 'task/e2e', task)
  writeFileSync(join(task, 'task.txt'), 'first\n'); git(task, 'add', '.'); git(task, 'commit', '-qm', 'task first')
  writeFileSync(join(task, 'task.txt'), 'first\nsecond\n'); git(task, 'commit', '-qam', 'task second')
  writeFileSync(join(task, 'pending.txt'), 'pending from e2e\n')

  git(repo, 'worktree', 'add', '-qb', 'conflict/e2e', conflict)
  writeFileSync(join(conflict, 'shared.txt'), 'task side\n'); git(conflict, 'commit', '-qam', 'conflicting task change')
  writeFileSync(join(repo, 'shared.txt'), 'main side\n'); git(repo, 'commit', '-qam', 'main conflict')
  git(repo, 'push', '-q', 'origin', 'main')
  const rebase = spawnSync('git', ['-C', conflict, 'rebase', 'main'], { encoding: 'utf8' })
  if (rebase.status === 0) throw new Error('The E2E conflict fixture did not conflict.')
}

async function request(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${driverUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.value?.error) throw new Error(`${path}: ${JSON.stringify(payload)}`)
  return payload.value
}

const route = path => `/session/${sessionId}${path}`
const elementKey = 'element-6066-11e4-a52e-4f735466cecf'
async function createSession() {
  const capabilities = provider === 'embedded' ? {} : { 'tauri:options': { application: app } }
  const until = Date.now() + 20000
  let lastError
  while (Date.now() < until) {
    if (appExit) {
      throw new Error(`Bento exited before WebDriver became ready (code=${appExit.code}, signal=${appExit.signal})`)
    }
    try {
      const value = await request('/session', { capabilities: { alwaysMatch: capabilities } })
      sessionId = value.sessionId ?? value.capabilities?.sessionId
      if (!sessionId) throw new Error(`Driver returned no session id: ${JSON.stringify(value)}`)
      return
    } catch (error) {
      lastError = error
      await delay(250)
    }
  }
  throw new Error(`WebDriver did not become ready at ${driverUrl}: ${String(lastError)}`)
}
async function find(using, value) {
  const found = await request(route('/element'), { using, value })
  return found[elementKey]
}
async function findAll(using, value) {
  return (await request(route('/elements'), { using, value })).map(item => item[elementKey])
}
async function waitFor(using, value, timeout = 15000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    try { return await find(using, value) } catch { await new Promise(resolve => setTimeout(resolve, 150)) }
  }
  throw new Error(`Timed out waiting for ${using}=${value}`)
}
async function clickWhen(using, value, timeout = 15000) {
  const until = Date.now() + timeout
  let lastError
  while (Date.now() < until) {
    try { await click(await find(using, value)); return } catch (error) { lastError = error; await delay(100) }
  }
  throw new Error(`Timed out clicking ${using}=${value}: ${String(lastError)}`)
}
async function waitUntil(check, description, timeout = 10000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await check()) return
    await delay(150)
  }
  throw new Error(`Timed out waiting for ${description}`)
}
const click = id => request(route(`/element/${id}/click`), {})
const type = (id, text) => request(route(`/element/${id}/value`), { text, value: [...text] })
const textOf = id => request(route(`/element/${id}/text`))
const execute = (script, args = []) => request(route('/execute/sync'), { script, args })
const refresh = () => request(route('/refresh'), {})
async function openTasksPanel() {
  await waitFor('css selector', '.session-manager[data-ready="true"]')
  let existing = await findAll('css selector', '[data-testid="tasks-panel"]')
  const restoredUntil = Date.now() + 2000
  while (!existing.length && Date.now() < restoredUntil) {
    await delay(100)
    existing = await findAll('css selector', '[data-testid="tasks-panel"]')
  }
  if (!existing.length) {
    await execute(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));`)
    await waitFor('css selector', '.cmdk-input')
    await click(await waitFor('css selector', '[data-command-id="new-tasks"]'))
  }
  return waitFor('css selector', '[data-testid="tasks-panel"]')
}
async function selectRepo(expectedBranch = 'task/e2e') {
  await openTasksPanel()
  await execute(`const panel = document.querySelector('[data-testid="tasks-panel"]'); localStorage.setItem('bento.tasks.repo.' + panel.dataset.panelId, arguments[0]);`, [repo])
  // Workspace layout persistence is debounced by Bento; let the newly-created
  // panel reach storage before reloading it with the repository preference.
  await delay(700)
  await refresh()
  await openTasksPanel()
  const selector = expectedBranch ? `[data-testid="tasks-row"][data-branch="${expectedBranch}"]` : '[data-testid="tasks-row"]'
  try {
    await waitFor('css selector', selector)
  } catch (error) {
    const ui = await execute(`const panel = document.querySelector('[data-testid="tasks-panel"]'); return {
      ready: document.querySelector('.session-manager')?.dataset.ready,
      panelId: panel?.dataset.panelId,
      storedRepo: panel ? localStorage.getItem('bento.tasks.repo.' + panel.dataset.panelId) : null,
      text: panel?.innerText?.slice(0, 1000),
    };`).catch(debugError => ({ debugError: String(debugError) }))
    const backend = await invoke('git_worktree_list', { repo }).catch(debugError => ({ debugError: String(debugError) }))
    throw new Error(`${String(error)}\nUI: ${JSON.stringify(ui)}\nBackend: ${JSON.stringify(backend)}`, { cause: error })
  }
}
async function invoke(command, args) {
  const result = await request(route('/execute/async'), {
    script: `const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(value => done({ value })).catch(error => done({ error: String(error) }));`,
    args: [command, args],
  })
  if (result?.error) throw new Error(`${command}: ${result.error}`)
  return result?.value
}
async function drag(from, to) {
  const a = await request(route(`/element/${from}/rect`))
  const b = await request(route(`/element/${to}/rect`))
  await request(route('/actions'), { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [
    { type: 'pointerMove', duration: 0, x: a.x + 8, y: a.y + a.height / 2, origin: 'viewport' },
    { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', duration: 350, x: b.x + 8, y: b.y + b.height - 2, origin: 'viewport' },
    { type: 'pointerUp', button: 0 },
  ] }] })
  await request(route('/actions'), undefined, 'DELETE')
}

async function run() {
  console.log('E2E: creating disposable Git repositories')
  fixture()
  startApp()
  await createSession()
  await waitUntil(
    async () => await execute('return typeof window.__TAURI_INTERNALS__?.invoke === "function";'),
    'the Tauri invoke bridge',
  )
  const identifier = await invoke('app_identifier', {})
  if (identifier !== 'com.romadev.bento.e2e') {
    throw new Error(`Refusing to run against non-isolated app identifier: ${identifier}. Build with npm run build:e2e:app.`)
  }
  isolatedProfile = true
  await invoke('workspace_reset', {})
  await execute('localStorage.clear(); sessionStorage.clear();')
  await refresh()
  console.log('E2E: opening Tasks panel')
  await selectRepo()

  console.log('E2E: switching locale without interpreting user content')
  await execute(`localStorage.setItem('bento.locale', 'en');`)
  await refresh()
  await waitFor('css selector', '.session-manager[data-ready="true"]')
  await waitUntil(
    async () => await execute(`return document.querySelector('.cmdk-input')?.placeholder;`).catch(() => null) === 'Type a command…',
    'the English command-palette locale',
  )
  await waitFor('css selector', '[data-testid="tasks-row"][data-branch="task/e2e"]')

  // Real commit through the Bento UI.
  console.log('E2E: committing through the UI')
  await click(await find('css selector', '[data-testid="tasks-row"][data-branch="task/e2e"]'))
  const message = await waitFor('css selector', '[data-testid="tasks-commit-message"]')
  await type(message, 'e2e commit from Bento')
  await click(await find('css selector', '[data-testid="tasks-commit"]'))
  await waitUntil(() => git(task, 'log', '-1', '--format=%s') === 'e2e commit from Bento', 'Bento UI commit')

  // Open the real rebase editor, preview and reorder by pointer actions.
  console.log('E2E: testing interactive rebase drag-and-drop')
  await click(await find('css selector', '[data-testid="tasks-row"][data-branch="task/e2e"] [data-testid="tasks-actions"]'))
  await click(await waitFor('xpath', "//*[contains(@class,'context-menu-item') and (contains(.,'Rebase interactivo') or contains(.,'Interactive rebase'))]"))
  let items = []
  await waitUntil(async () => {
    items = await request(route('/elements'), { using: 'css selector', value: '[data-testid="tasks-rebase-item"]' })
    return items.length >= 2
  }, 'at least two interactive-rebase commits')
  await drag(items[0][elementKey], items[1][elementKey])
  await click(await find('css selector', '[data-testid="tasks-rebase-preview"]'))
  if (!(await textOf(await find('css selector', '.tasks-rebase-preview'))).match(/Resultado previsto|Expected result|commits/)) throw new Error('Rebase preview was not rendered.')

  // Start a paused edit through the real Tauri invoke bridge, restart Bento,
  // and verify that the panel recovers the active operation.
  console.log('E2E: testing paused-rebase recovery after app restart')
  const commits = git(task, 'rev-list', '--reverse', 'origin/main..HEAD').split('\n')
  await invoke('git_rebase_start', { path: task, base: 'main', todoLines: commits.map((hash, index) => `${index ? 'pick' : 'edit'} ${hash} e2e`) })
  await request(`/session/${sessionId}`, undefined, 'DELETE')
  sessionId = ''
  if (provider === 'embedded') {
    await stopApp()
    startApp()
  }
  await createSession()
  // The embedded test driver uses an isolated WebView profile on each process,
  // so restore the repository preference before checking the persisted Git state.
  await selectRepo(null)
  await waitFor('xpath', "//*[contains(.,'Continuar rebase') or contains(.,'Continue rebase')]", 20000)
  await invoke('git_rebase_abort', { path: task })

  // Recover and render a genuine conflicted rebase.
  console.log('E2E: resolving a genuine rebase conflict')
  await refresh()
  await waitFor('css selector', '.tasks-conflict-file')
  await clickWhen('css selector', '.tasks-conflict-btn-primary')
  await waitFor('css selector', '[data-testid="tasks-conflict-resolver"]')
  const choices = await findAll('css selector', '.tasks-conflict-pick-btn')
  await click(choices[0])
  await click(await find('css selector', '[data-testid="tasks-conflict-save"]'))
  await waitUntil(() => {
    const lock = git(conflict, 'rev-parse', '--git-path', 'index.lock')
    return git(conflict, 'diff', '--name-only', '--diff-filter=U') === '' && !existsSync(lock)
  }, 'conflict resolution to finish writing the Git index')
  await invoke('git_rebase_abort', { path: conflict })

  // Create an automatic backup through Bento's backend and verify its UI.
  console.log('E2E: verifying backup recovery UI')
  await invoke('git_reset', { path: task, target: 'HEAD^', mode: 'mixed' })
  await refresh()
  await waitFor('css selector', '[data-testid="tasks-row"][data-branch="task/e2e"]')
  await clickWhen('css selector', '[data-testid="tasks-row"][data-branch="task/e2e"] [data-testid="tasks-actions"]')
  await clickWhen('xpath', "//*[contains(@class,'context-menu-item') and (contains(.,'respaldos') or contains(.,'Backup'))]")
  await waitFor('css selector', '[data-testid="tasks-backup-history"]')
  console.log('Bento task-panel E2E passed: commit, drag/drop, restart recovery, conflict resolver and backups.')
}

try { await run() } finally {
  if (sessionId && isolatedProfile) await invoke('workspace_reset', {}).catch(() => {})
  if (sessionId && isolatedProfile) await execute('localStorage.clear(); sessionStorage.clear();').catch(() => {})
  if (sessionId) await fetch(`${driverUrl}/session/${sessionId}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) }).catch(() => {})
  driver?.kill('SIGTERM')
  await stopApp()
  rmSync(root, { recursive: true, force: true })
}
