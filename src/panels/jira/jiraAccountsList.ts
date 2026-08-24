import type { JiraAccount } from './jiraClient'
import { note, mkBtn } from './jiraWidgets'

// La lista de cuentas de la barra lateral: cuál está seleccionada, editarla y
// quitarla.

export interface JiraAccountsListDeps {
  list: HTMLElement
  accounts: () => JiraAccount[]
  selectedAccountId: () => string
  selectAccount: (account: JiraAccount) => void
  editAccount: (account: JiraAccount) => void
  removeAccount: (account: JiraAccount) => void
}

export function buildJiraAccountsList(deps: JiraAccountsListDeps): () => void {
  const renderAccounts = (): void => {
    deps.list.replaceChildren()
    if (!deps.accounts().length) {
      deps.list.append(note('Sin cuentas. Usa + para añadir una.', 'jira-note'))
      return
    }
    for (const a of deps.accounts()) {
      const row = document.createElement('div')
      row.className = a.id === deps.selectedAccountId() ? 'jira-account-row selected' : 'jira-account-row'
      const label = Object.assign(document.createElement('span'), { className: 'jira-account-label', textContent: a.email, title: a.email })
      const del = mkBtn('trash', 'Eliminar cuenta', () => deps.removeAccount(a))
      del.classList.add('jira-account-del')
      del.addEventListener('click', (e: Event) => e.stopPropagation())
      row.append(label, del)
      row.addEventListener('click', () => deps.selectAccount(a))
      deps.list.append(row)
    }
  }

  // Accounts live one-per-group so the trash button appears per account.
  return renderAccounts
}
