import { parseDiffFiles } from '../diff/diffStats'
import type { AgentType } from '../../core/ai/config'
import type { MultiAgentReviewRun } from '../../core/ai/techReview'
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

export function resolveReviewFollowUpSession(reviewRuns: MultiAgentReviewRun[], reviewAgentCount: number): { sessionId: string | null; sessionAgent: AgentType | null } {
  const run = reviewRuns
    .slice(0, reviewAgentCount)
    .reverse()
    .find(run => run.sessionId)
  return {
    sessionId: run?.sessionId ?? null,
    sessionAgent: run?.agent ?? null,
  }
}

export function buildReviewFileManifest(files: ReviewChangeFile[]): string {
  return files.map(file => `${file.state} ${file.file} (+${file.additions}/-${file.deletions})`).join('\n')
}

export function buildReviewFileBatches(files: ReviewChangeFile[], maxBatchChars = 12_000): ReviewChangeFile[][] {
  if (!files.length) return []
  const batches: ReviewChangeFile[][] = []
  let batch: ReviewChangeFile[] = []
  let chars = 0
  files.forEach(file => {
    const nextChars = chars + file.chunk.length
    if (batch.length && nextChars > maxBatchChars) {
      batches.push(batch)
      batch = []
      chars = 0
    }
    batch.push(file)
    chars += file.chunk.length
  })
  if (batch.length) batches.push(batch)
  return batches
}

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
    title: mergedAt ? `Merged at ${new Date(mergedAt).toLocaleString()}` : normalized,
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
const KW: Record<string, string[]> = {
  ts: ['const','let','var','function','return','if','else','for','while','class','import','export','from','default','async','await','new','this','typeof','null','undefined','true','false','void','type','interface','enum','extends','implements','public','private','protected','readonly','static','abstract','switch','case','break','continue','try','catch','finally','throw','delete','in','of','instanceof'],
  rs: ['fn','let','mut','const','struct','enum','impl','trait','use','pub','mod','return','if','else','for','while','match','Some','None','Ok','Err','true','false','self','Self','super','crate','async','await','move','where','type','ref','loop','break','continue'],
  py: ['def','class','return','if','else','elif','for','while','import','from','as','with','in','not','and','or','is','None','True','False','pass','break','continue','try','except','finally','raise','yield','async','await','lambda','global','nonlocal'],
  go: ['func','var','const','return','if','else','for','range','go','select','case','default','break','continue','type','struct','interface','import','package','nil','true','false','defer','make','new','len','cap','chan','map','switch'],
  css: ['@import','@media','@keyframes','@font-face','!important'],
}
const EXT_LANG: Record<string, string> = {
  ts:'ts', tsx:'ts', js:'ts', jsx:'ts', mjs:'ts', cjs:'ts',
  rs:'rs', py:'py', go:'go', css:'css', scss:'css',
}

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const sp = (cls: string, text: string): string => `<span class="sh-${cls}">${esc(text)}</span>`

export function highlightCode(code: string, ext: string): string {
  const lang = EXT_LANG[ext.toLowerCase()]
  if (!lang) return esc(code)
  const kws = new Set(KW[lang] ?? [])
  const commentPfx = lang === 'py' ? '#' : '//'
  const result: string[] = []
  let i = 0
  while (i < code.length) {
    if (code.startsWith(commentPfx, i)) { result.push(sp('comment', code.slice(i))); break }
    if (lang !== 'py' && code.startsWith('/*', i)) {
      const end = code.indexOf('*/', i + 2)
      const s = end === -1 ? code.slice(i) : code.slice(i, end + 2)
      result.push(sp('comment', s)); i += s.length; continue
    }
    const q = code[i]
    if (q === '"' || q === "'" || q === '`') {
      let j = i + 1
      while (j < code.length) {
        if (code[j] === '\\') { j += 2; continue }
        if (code[j] === q) { j++; break }
        j++
      }
      result.push(sp('string', code.slice(i, j))); i = j; continue
    }
    if (code[i] >= '0' && code[i] <= '9') {
      let j = i
      while (j < code.length && /[\d._a-zA-Z]/.test(code[j])) j++
      result.push(sp('number', code.slice(i, j))); i = j; continue
    }
    if (/[a-zA-Z_$]/.test(code[i])) {
      let j = i
      while (j < code.length && /[\w$]/.test(code[j])) j++
      const word = code.slice(i, j)
      result.push(kws.has(word) ? sp('keyword', word) : esc(word)); i = j; continue
    }
    result.push(esc(code[i])); i++
  }
  return result.join('')
}

// ── File state from diff chunk ────────────────────────────────────────────────
export const getFileState = (chunk: string): 'A' | 'D' | 'M' => {
  if (/^new file mode/m.test(chunk)) return 'A'
  if (/^deleted file mode/m.test(chunk)) return 'D'
  return 'M'
}

// ── CI status ─────────────────────────────────────────────────────────────────
export const computeCiStatus = (rollup: Array<{ conclusion?: string | null; state?: string }>): 'success' | 'failure' | 'pending' | 'none' => {
  if (!rollup?.length) return 'none'
  const vals = rollup.map(c => (c.conclusion ?? c.state ?? '').toUpperCase())
  if (vals.some(v => ['FAILURE','ERROR','TIMED_OUT','CANCELLED'].includes(v))) return 'failure'
  if (vals.some(v => ['PENDING','IN_PROGRESS','QUEUED','WAITING','ACTION_REQUIRED'].includes(v))) return 'pending'
  return 'success'
}

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
