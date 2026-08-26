import { t as i18nT } from '../../i18n'
import { invoke } from '@tauri-apps/api/core'
import { icon } from '../../ui/helpers/icons'

interface VaultEntry { id: string; service: string; username: string; url: string; notes: string }

export function createVaultPanel(): { element: HTMLElement } {
  const root = document.createElement('div')
  root.className = 'vault-panel'

  const show = (...nodes: HTMLElement[]): void => root.replaceChildren(...nodes)

  const mkBtn = (iconName: string, title: string, onClick: () => void, cls = 'vault-action'): HTMLButtonElement => {
    const b = document.createElement('button')
    b.className = cls
    b.title = title
    b.innerHTML = icon(iconName)
    b.addEventListener('click', onClick)
    return b
  }

  const field = (label: string, value = '', type = 'text'): { row: HTMLElement; input: HTMLInputElement } => {
    const row = document.createElement('label')
    row.className = 'vault-field'
    const lbl = document.createElement('span')
    lbl.textContent = label
    const input = document.createElement('input')
    input.className = 'vault-input'
    input.type = type
    input.value = value
    row.append(lbl, input)
    return { row, input }
  }

  const statusEl = (): HTMLElement => {
    const el = document.createElement('div')
    el.className = 'vault-status'
    return el
  }

  // ---- lock screen ----
  const renderLock = async (): Promise<void> => {
    const exists = await invoke<boolean>('vault_exists')
    const wrap = document.createElement('div')
    wrap.className = 'vault-lock-wrap'
    const lockIcon = document.createElement('div')
    lockIcon.className = 'vault-lock-icon'
    lockIcon.innerHTML = icon('lock')
    const title = document.createElement('div')
    title.className = 'vault-lock-title'
    title.textContent = exists ? i18nT('vault.vaultLocked') : i18nT('vault.createVault')
    const sub = document.createElement('div')
    sub.className = 'vault-lock-sub'
    sub.textContent = exists ? i18nT('vault.enterYourMasterPasswordToContinue') : i18nT('vault.chooseAMasterPasswordToProtectYourCredentials')
    const pwField = field(i18nT('vault.masterPassword'), '', 'password')
    const status = statusEl()
    const btn = document.createElement('button')
    btn.className = 'vault-primary'
    btn.textContent = exists ? i18nT('vault.unlock') : i18nT('vault.createVault')
    btn.addEventListener('click', async () => {
      const pw = pwField.input.value
      if (!pw) return
      btn.disabled = true
      status.textContent = exists ? i18nT('vault.verifying') : i18nT('common.creating')
      try {
        if (exists) {
          await invoke('vault_unlock', { password: pw })
        } else {
          await invoke('vault_setup', { password: pw })
        }
        renderList()
      } catch (e) {
        status.textContent = String(e)
        btn.disabled = false
      }
    })
    pwField.input.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click() })
    wrap.append(lockIcon, title, sub, pwField.row, btn, status)
    show(wrap)
  }

  // ---- credential list ----
  const renderList = async (): Promise<void> => {
    const entries = await invoke<VaultEntry[]>('vault_list').catch(() => [] as VaultEntry[])

    const header = document.createElement('div')
    header.className = 'vault-header'
    const titleEl = document.createElement('span')
    titleEl.className = 'vault-title'
    titleEl.textContent = i18nT('vault.panelTitle')
    const addBtn = mkBtn('plus', i18nT('vault.addCredential'), () => renderForm())
    const lockBtn = mkBtn('lock', i18nT('vault.lock'), async () => {
      await invoke('vault_lock')
      renderLock()
    })
    header.append(titleEl, addBtn, lockBtn)

    const list = document.createElement('div')
    list.className = 'vault-list'

    if (!entries.length) {
      const empty = document.createElement('div')
      empty.className = 'vault-empty'
      empty.textContent = i18nT('vault.noCredentialsYetUseToAddOne')
      list.append(empty)
    } else {
      entries.forEach(e => list.append(makeRow(e)))
    }

    show(header, list)
  }

  const confirmDelete = (e: VaultEntry): void => {
    const overlay = document.createElement('div')
    overlay.className = 'vault-confirm-overlay'
    overlay.addEventListener('click', ev => { if (ev.target === overlay) overlay.remove() })

    const modal = document.createElement('div')
    modal.className = 'vault-confirm-modal'

    const title = document.createElement('div')
    title.className = 'vault-confirm-title'
    title.textContent = i18nT('vault.deleteService', { service: e.service })

    const sub = document.createElement('div')
    sub.className = 'vault-lock-sub'
    sub.textContent = i18nT('vault.enterYourMasterPasswordToConfirm')

    const pwField = field(i18nT('vault.masterPassword'), '', 'password')
    const status = statusEl()

    const actions = document.createElement('div')
    actions.className = 'vault-confirm-actions'

    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'vault-transition-btn'
    cancelBtn.textContent = i18nT('common.cancel')
    cancelBtn.addEventListener('click', () => overlay.remove())

    const confirmBtn = document.createElement('button')
    confirmBtn.className = 'vault-primary vault-danger'
    confirmBtn.textContent = i18nT('common.delete')
    confirmBtn.addEventListener('click', async () => {
      const pw = pwField.input.value
      if (!pw) return
      confirmBtn.disabled = true
      status.textContent = i18nT('vault.verifying')
      const ok = await invoke<boolean>('vault_verify_password', { password: pw })
      if (!ok) {
        status.textContent = i18nT('vault.incorrectPassword')
        confirmBtn.disabled = false
        return
      }
      await invoke('vault_delete', { id: e.id })
      overlay.remove()
      renderList()
    })

    pwField.input.addEventListener('keydown', ev => { if (ev.key === 'Enter') confirmBtn.click() })
    actions.append(cancelBtn, confirmBtn)
    modal.append(title, sub, pwField.row, status, actions)
    overlay.append(modal)
    root.append(overlay)
    pwField.input.focus()
  }

  const makeRow = (e: VaultEntry): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'vault-row'

    // Initials avatar
    const avatar = document.createElement('div')
    avatar.className = 'vault-avatar'
    avatar.textContent = e.service.slice(0, 2).toUpperCase()
    const hue = [...e.service].reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xffff, 0) % 360
    avatar.style.background = `hsl(${hue} 55% 38%)`

    const info = document.createElement('div')
    info.className = 'vault-row-info'
    const svc = document.createElement('div')
    svc.className = 'vault-row-service'
    svc.textContent = e.service
    const usr = document.createElement('div')
    usr.className = 'vault-row-username'
    usr.textContent = e.username
    info.append(svc, usr)

    const actions = document.createElement('div')
    actions.className = 'vault-row-actions'

    // Copy username
    const copyUser = mkBtn('list', i18nT('vault.copyUsername'), async () => {
      await navigator.clipboard.writeText(e.username)
      flash(copyUser)
    })

    // Copy password
    const copyPw = mkBtn('copy', i18nT('vault.copyPassword'), async () => {
      const pw = await invoke<string>('vault_get_password', { id: e.id })
      await navigator.clipboard.writeText(pw)
      flash(copyPw)
    })

    // Edit
    const editBtn = mkBtn('settings', i18nT('vault.edit'), () => renderForm(e))

    // Delete — requires master password confirmation
    const delBtn = mkBtn('trash', i18nT('common.delete'), () => confirmDelete(e))

    actions.append(copyUser, copyPw, editBtn, delBtn)
    row.append(avatar, info, actions)
    return row
  }

  const flash = (btn: HTMLElement): void => {
    btn.classList.add('vault-copied')
    setTimeout(() => btn.classList.remove('vault-copied'), 1200)
  }

  // ---- add / edit form ----
  const renderForm = (existing?: VaultEntry): void => {
    const header = document.createElement('div')
    header.className = 'vault-header'
    const titleEl = document.createElement('span')
    titleEl.className = 'vault-title'
    titleEl.textContent = existing ? i18nT('vault.editCredential') : i18nT('vault.newCredential')
    const backBtn = mkBtn('arrow-left', i18nT('common.back'), () => renderList())
    header.append(titleEl, backBtn)

    const service = field(i18nT('vault.service'), existing?.service ?? '')
    service.input.placeholder = i18nT('vault.servicePlaceholder')
    const username = field(i18nT('vault.usernameEmail'), existing?.username ?? '')
    const password = field(i18nT('vault.password'), '', 'password')
    password.input.placeholder = existing ? i18nT('vault.leaveEmptyToKeepUnchanged') : ''
    const url = field(i18nT('vault.optionalUrl'), existing?.url ?? '')
    const notes = field(i18nT('vault.optionalNotes'), existing?.notes ?? '')

    // Toggle show/hide password. When revealing an existing entry, it fetches the
    // stored password (not preloaded for security; only when asked to view it).
    const togglePw = mkBtn('eye', i18nT('vault.showPassword'), async () => {
      const revealing = password.input.type === 'password'
      if (revealing && existing && !password.input.value) {
        password.input.value = await invoke<string>('vault_get_password', { id: existing.id }).catch(() => '')
      }
      password.input.type = revealing ? 'text' : 'password'
    })
    const pwWrap = document.createElement('div')
    pwWrap.className = 'vault-pw-wrap'
    pwWrap.append(password.row, togglePw)

    const status = statusEl()
    const save = document.createElement('button')
    save.className = 'vault-primary'
    save.textContent = existing ? i18nT('vault.saveChanges') : i18nT('common.save')
    save.addEventListener('click', async () => {
      const s = service.input.value.trim()
      const u = username.input.value.trim()
      const p = password.input.value
      if (!s || !u) { status.textContent = i18nT('vault.serviceAndUsernameAreRequired'); return }
      if (!existing && !p) { status.textContent = i18nT('vault.passwordIsRequired'); return }
      save.disabled = true
      status.textContent = i18nT('vault.saving')
      try {
        if (existing) {
          await invoke('vault_update', { id: existing.id, service: s, username: u, password: p, url: url.input.value.trim(), notes: notes.input.value.trim() })
        } else {
          await invoke('vault_add', { service: s, username: u, password: p, url: url.input.value.trim(), notes: notes.input.value.trim() })
        }
        renderList()
      } catch (e) {
        status.textContent = String(e)
        save.disabled = false
      }
    })

    const form = document.createElement('div')
    form.className = 'vault-form'
    form.append(service.row, username.row, pwWrap, url.row, notes.row, save, status)
    show(header, form)
  }

  // ---- boot ----
  invoke<boolean>('vault_is_unlocked').then(unlocked => {
    if (unlocked) renderList()
    else renderLock()
  }).catch(() => renderLock())

  return { element: root }
}
