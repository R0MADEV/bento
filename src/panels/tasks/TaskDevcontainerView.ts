import { invoke } from '@tauri-apps/api/core'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { confirm as askConfirm } from '@tauri-apps/plugin-dialog'
import type { Worktree } from '../../core/git/worktree'
import { icon } from '../../ui/helpers/icons'
import { taskT } from './i18n'

export interface IsolateResult {
  subnet: string
  urls: { service: string; url: string }[]
  recipe?: RecipeApplyResult
}

export interface RecipeFilePreview {
  path: string
  action: 'create' | 'overwrite' | 'overwrite-tracked' | 'unchanged'
  tracked: boolean
}

export interface RecipePreview {
  projectKey: string
  recipeDir?: string
  recipeExists: boolean
  devcontainerDirs: string[]
  files: RecipeFilePreview[]
  warnings: string[]
}

export interface RecipeApplyResult {
  projectKey: string
  recipeDir: string
  devcontainerDir: string
  applied: string[]
  skipped: string[]
  errors: string[]
  appliedAt: number
}

function note(text: string, className = 'tasks-note'): HTMLElement {
  return Object.assign(document.createElement('div'), { className, textContent: text })
}

function iconButton(name: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'tasks-icon-btn'
  button.title = title
  button.setAttribute('aria-label', title)
  button.innerHTML = icon(name)
  button.addEventListener('click', onClick)
  return button
}


export interface TaskDevcontainerDeps {
  showDetail: (...nodes: HTMLElement[]) => void
  resetDetail: () => void
}

export function buildTaskDevcontainerView(deps: TaskDevcontainerDeps) {
  const showDevcontainer = (result: IsolateResult, worktree: Worktree, onReapply?: () => void): void => {
    deps.resetDetail()
    const wrap = document.createElement('div')
    wrap.className = 'tasks-docker-detail'
    wrap.appendChild(note(result.subnet ? taskT('devcontainerReady', { subnet: result.subnet }) : taskT('devcontainerReadyNoSubnet'), 'db-detail-hint'))
    wrap.appendChild(note(taskT('openInVscodeHint'), 'db-detail-hint'))
    const controls = document.createElement('div')
    controls.className = 'tasks-compose-controls'
    controls.appendChild(iconButton('code', taskT('openEditor'), () => { invoke('open_in_editor', { path: worktree.path }).catch(console.error) }))
    if (onReapply) controls.appendChild(iconButton('refresh', taskT('reapplyRecipe'), onReapply))
    if (result.recipe?.recipeDir) {
      controls.appendChild(iconButton('folder', taskT('openRecipeFolder'), () => {
        invoke('open_in_editor', { path: result.recipe!.recipeDir }).catch(console.error)
      }))
    }
    wrap.appendChild(controls)
    if (result.recipe) {
      const recipe = document.createElement('div')
      recipe.className = 'tasks-recipe-result'
      recipe.append(
        note(taskT('recipeAppliedSummary', {
          project: result.recipe.projectKey,
          applied: result.recipe.applied.length,
          skipped: result.recipe.skipped.length,
          errors: result.recipe.errors.length,
        }), result.recipe.errors.length ? 'db-detail-error' : 'db-detail-hint'),
        note(taskT('recipeAppliedAt', {
          date: new Date(result.recipe.appliedAt * 1000).toLocaleString(),
          devcontainer: result.recipe.devcontainerDir,
        }), 'db-detail-hint'),
      )
      if (result.recipe.applied.length) recipe.appendChild(note(`${taskT('recipeAppliedFiles')}: ${result.recipe.applied.join(', ')}`))
      if (result.recipe.skipped.length) recipe.appendChild(note(`${taskT('recipeSkippedFiles')}: ${result.recipe.skipped.join(', ')}`))
      for (const error of result.recipe.errors) recipe.appendChild(note(error, 'db-detail-error'))
      wrap.appendChild(recipe)
    }
    if (result.urls.length) {
      const urls = document.createElement('div')
      urls.className = 'tasks-url-list'
      for (const entry of result.urls) {
        const link = Object.assign(document.createElement('a'), { className: 'tasks-url-link', href: '#', textContent: `${entry.service} → ${entry.url}` })
        link.addEventListener('click', event => { event.preventDefault(); openUrl(entry.url).catch(() => {}) })
        urls.appendChild(link)
      }
      wrap.appendChild(urls)
    }
    deps.showDetail(wrap)
  }

  const prepareDevcontainer = async (
    worktree: Worktree,
    recipesDir: string | undefined,
    projectKey: string,
    preferredDevcontainerDir?: string,
    onDevcontainerSelected?: (path: string) => void,
  ): Promise<boolean> => {
    deps.resetDetail()
    try {
      const preview = await invoke<RecipePreview>('devcontainer_recipe_preview', {
        worktreePath: worktree.path,
        recipesDir: recipesDir || null,
        projectKey,
      })
      if (!preview.devcontainerDirs.length) return false

      const wrap = document.createElement('div')
      wrap.className = 'tasks-recipe-preview'
      wrap.appendChild(Object.assign(document.createElement('h3'), { textContent: taskT('recipePreview') }))
      wrap.appendChild(note(preview.recipeExists
        ? taskT('recipePreviewSummary', { project: projectKey, count: preview.files.length })
        : taskT('recipeMissingGeneric', { project: projectKey }), 'db-detail-hint'))

      const selected = document.createElement('select')
      selected.className = 'tasks-settings-input'
      for (const path of preview.devcontainerDirs) {
        selected.appendChild(Object.assign(document.createElement('option'), {
          value: path,
          textContent: path,
          selected: path === preferredDevcontainerDir,
        }))
      }
      if (preview.devcontainerDirs.length > 1) {
        const label = Object.assign(document.createElement('label'), {
          className: 'tasks-settings-label', textContent: taskT('chooseDevcontainer'),
        })
        label.appendChild(selected)
        wrap.appendChild(label)
      }

      const files = document.createElement('div')
      files.className = 'tasks-recipe-files'
      for (const file of preview.files) {
        const row = document.createElement('div')
        row.className = `tasks-recipe-file tasks-recipe-file--${file.action}`
        row.append(
          Object.assign(document.createElement('code'), { textContent: file.path }),
          Object.assign(document.createElement('span'), { textContent: taskT(`recipeAction_${file.action}`) }),
        )
        files.appendChild(row)
      }
      if (preview.files.length) wrap.appendChild(files)
      for (const warning of preview.warnings) {
        const [kind, ...pathParts] = warning.split(':')
        const path = pathParts.join(':')
        const message = kind === 'multiple-devcontainers'
          ? taskT('multipleDevcontainersWarning')
          : kind === 'postcreate-not-executable'
            ? taskT('postcreateExecutableWarning', { path })
            : kind === 'invalid-compose-override'
              ? taskT('invalidOverrideWarning', { path })
              : taskT('recipeWarning', { warning })
        wrap.appendChild(note(message, 'db-detail-error'))
      }

      const status = note('')
      const controls = document.createElement('div')
      controls.className = 'tasks-compose-controls'
      const apply = iconButton('play', taskT('applyRecipe'), () => {
        void (async () => {
          const destructive = preview.files.filter(file => file.action === 'overwrite' || file.action === 'overwrite-tracked')
          const tracked = destructive.filter(file => file.tracked)
          if (destructive.length && !await askConfirm(
            taskT('confirmRecipeOverwrite', { count: destructive.length }),
            { title: taskT('applyRecipe'), kind: 'warning' },
          )) return
          let allowTracked = false
          if (tracked.length) {
            allowTracked = await askConfirm(
              taskT('confirmTrackedOverwrite', { count: tracked.length }),
              { title: taskT('trackedFiles'), kind: 'warning' },
            )
            if (!allowTracked) return
          }
          apply.disabled = true
          status.textContent = taskT('applyingRecipe')
          const devcontainerDir = selected.value
          try {
            const result = await invoke<IsolateResult>('devcontainer_isolate', {
              worktreePath: worktree.path,
              recipesDir: recipesDir || null,
              projectKey,
              devcontainerDir,
              allowTracked,
            })
            onDevcontainerSelected?.(devcontainerDir)
            showDevcontainer(result, worktree, () => {
              void prepareDevcontainer(worktree, recipesDir, projectKey, devcontainerDir, onDevcontainerSelected)
            })
          } catch (error) {
            apply.disabled = false
            status.className = 'db-detail-error'
            status.textContent = String(error)
          }
        })()
      })
      controls.append(apply, status)
      wrap.appendChild(controls)
      deps.showDetail(wrap)
      return true
    } catch (error) {
      const message = String(error)
      if (message === 'no-devcontainer') return false
      deps.showDetail(note(message, 'db-detail-error'))
      return true
    }
  }

  // Cheap re-display of a prepared task's URLs (reads .devcontainer/.env, no isolate).
  // Returns false when the task isn't a prepared devcontainer.
  const showDevcontainerUrls = async (worktree: Worktree, devcontainerDir?: string, shouldShow = () => true): Promise<boolean> => {
    try {
      const urls = await invoke<{ service: string; url: string }[]>('devcontainer_urls', {
        worktreePath: worktree.path,
        devcontainerDir: devcontainerDir || null,
      })
      const recipe = await invoke<RecipeApplyResult | null>('devcontainer_recipe_status', {
        worktreePath: worktree.path,
        devcontainerDir: devcontainerDir || null,
      }).catch(() => null)
      if (!shouldShow()) return true
      showDevcontainer({ subnet: '', urls, recipe: recipe ?? undefined }, worktree)
      return true
    } catch {
      return false
    }
  }

  return { showDevcontainer, prepareDevcontainer, showDevcontainerUrls }
}
