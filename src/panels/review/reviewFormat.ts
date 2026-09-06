import hljs from 'highlight.js/lib/common'
import { parseDiffFiles } from '../../core/git/diffStats'
import { reviewT } from './i18n'

export type ReviewChangeFile = ReturnType<typeof parseDiffFiles>[0] & { state: 'A' | 'D' | 'M' }

export interface GhComment {
  id: number
  path: string
  line: number
  body: string
  user: { login: string }
  html_url: string
  created_at?: string
}

export interface GhPr {
  number: number
  title: string
  url: string
  headRefName: string
  baseRefName: string
  author: { login: string }
  state?: 'OPEN' | 'CLOSED' | 'MERGED' | string
  mergedAt?: string | null
}

export type SidebarMode = 'branches' | 'prs'
export type FileTypeFilter = 'all' | 'A' | 'M' | 'D' | 'commented'


export function describeReviewPrState(state?: string | null, mergedAt?: string | null): { text: string; cls: string; title: string } | null {
  const normalized = (state ?? '').toUpperCase()
  const map: Record<string, { text: string; cls: string }> = {
    OPEN: { text: 'Open', cls: 'review-pr-state--open' },
    DRAFT: { text: 'Draft', cls: 'review-pr-state--draft' },
    MERGED: { text: 'Merged', cls: 'review-pr-state--merged' },
    CLOSED: { text: 'Closed', cls: 'review-pr-state--closed' },
  }
  const badge = map[normalized]
  if (!badge) return null
  return {
    text: badge.text,
    cls: badge.cls,
    title: mergedAt ? reviewT('mergedAt', { date: new Date(mergedAt).toLocaleString() }) : normalized,
  }
}

export function renderReviewPrStateBadge(state: string | null | undefined, mergedAt: string | null | undefined, classPrefix: string): HTMLSpanElement | null {
  const badge = describeReviewPrState(state, mergedAt)
  if (!badge) return null
  return Object.assign(document.createElement('span'), {
    className: `${classPrefix} ${badge.cls}`,
    textContent: badge.text,
    title: badge.title,
  })
}

export function describeReviewNoBranchChanges(state?: string | null, baseBranch = ''): string {
  if ((state ?? '').toUpperCase() === 'MERGED') {
    return reviewT('mergedNoBranchChanges', { base: baseBranch })
  }
  return reviewT('noBranchChanges', { base: baseBranch })
}

// El aviso de que la review es de otro commit, o `null` si no lo es. El commit
// se guarda con cada review para esto; hasta ahora se estampaba y no lo leía
// nadie. Sin uno de los dos shas no se avisa: no haber podido leerlo no es
// prueba de que algo cambiara.
export function describeReviewStaleness(saved: string, current: string): string | null {
  const canCompare = Boolean(saved) && Boolean(current)
  if (!canCompare || saved === current) return null
  return reviewT('staleReview', { commit: saved.slice(0, 7) })
}

export function filterReviewPrs(prs: readonly GhPr[], query: string): GhPr[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...prs]
  return prs.filter(pr => {
    const fields = [
      String(pr.number),
      pr.title,
      pr.author.login,
      pr.headRefName,
      pr.baseRefName,
      pr.state ?? '',
    ]
    return fields.some(value => value.toLowerCase().includes(q))
  })
}

// ── Syntax highlighting ───────────────────────────────────────────────────────
// Con highlight.js: reconoce el lenguaje de verdad en vez de buscar palabras
// en una lista, así que distingue un tipo de una función y cubre los cuarenta
// lenguajes que trae `common` —JSON, CSS, SQL, YAML, Markdown…—, no los cuatro
// que había escritos a mano. La CLI hace lo mismo con syntect y la paleta es
// la de Bento en los dos.
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript',
  rs: 'rust', py: 'python', go: 'go', css: 'css', scss: 'scss',
  json: 'json', yml: 'yaml', yaml: 'yaml', md: 'markdown', sql: 'sql',
  sh: 'bash', bash: 'bash', zsh: 'bash', toml: 'ini', html: 'xml', xml: 'xml',
  java: 'java', kt: 'kotlin', swift: 'swift', rb: 'ruby', php: 'php',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
}

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function highlightCode(code: string, ext: string): string {
  const lang = EXT_LANG[ext.toLowerCase()]
  // Sin lenguaje reconocido se deja en plano: pintarlo con las reglas de otro
  // es peor que no pintarlo. `ignoreIllegals` porque una línea suelta de un
  // diff casi nunca es un fichero válido.
  if (!lang || !hljs.getLanguage(lang)) return esc(code)
  try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value }
  catch { return esc(code) }
}

// ── File state from diff chunk ────────────────────────────────────────────────
export const getFileState = (chunk: string): 'A' | 'D' | 'M' => {
  if (/^new file mode/m.test(chunk)) return 'A'
  if (/^deleted file mode/m.test(chunk)) return 'D'
  return 'M'
}

// ── CI status ─────────────────────────────────────────────────────────────────
// ── Relative time ─────────────────────────────────────────────────────────────
export const relativeTime = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60000) return 'just now'
  const min = Math.floor(diff / 60000)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

// ── Word-level diff ───────────────────────────────────────────────────────────
export const wordDiff = (oldText: string, newText: string): { oldHtml: string; newHtml: string } => {
  const tokenize = (s: string): string[] => {
    const r: string[] = []
    let i = 0
    while (i < s.length) {
      if (/\w/.test(s[i])) {
        let j = i; while (j < s.length && /\w/.test(s[j])) j++
        r.push(s.slice(i, j)); i = j
      } else { r.push(s[i]); i++ }
    }
    return r
  }
  const a = tokenize(oldText), b = tokenize(newText)
  if (a.length > 300 || b.length > 300) return { oldHtml: esc(oldText), newHtml: esc(newText) }
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let ii = 1; ii <= m; ii++)
    for (let jj = 1; jj <= n; jj++)
      dp[ii][jj] = a[ii-1] === b[jj-1] ? dp[ii-1][jj-1] + 1 : Math.max(dp[ii-1][jj], dp[ii][jj-1])
  type Op = { t: '='; v: string } | { t: '-'; v: string } | { t: '+'; v: string }
  const ops: Op[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) { ops.unshift({ t: '=', v: a[i-1] }); i--; j-- }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { ops.unshift({ t: '+', v: b[j-1] }); j-- }
    else { ops.unshift({ t: '-', v: a[i-1] }); i-- }
  }
  let oldHtml = '', newHtml = ''
  for (const op of ops) {
    if (op.t === '=') { oldHtml += esc(op.v); newHtml += esc(op.v) }
    else if (op.t === '-') oldHtml += `<mark class="sh-word-del">${esc(op.v)}</mark>`
    else newHtml += `<mark class="sh-word-add">${esc(op.v)}</mark>`
  }
  return { oldHtml, newHtml }
}
