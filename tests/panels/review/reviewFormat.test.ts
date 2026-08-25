import { describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import {
  describeReviewNoBranchChanges,
  describeReviewPrState,
  esc,
  filterReviewPrs,
  getFileState,
  highlightCode,
  relativeTime,
  wordDiff,
} from '../../../src/panels/review/reviewFormat'

function setup() {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'en')
}

describe('describeReviewPrState / describeReviewNoBranchChanges', () => {
  it('describes merged PRs explicitly', () => {
    expect(describeReviewPrState('MERGED', '2026-08-14T00:00:00Z')).toMatchObject({
      text: 'Merged',
      cls: 'review-pr-state--merged',
    })
  })

  it('returns null for an unknown state', () => {
    expect(describeReviewPrState('BOGUS', null)).toBeNull()
  })

  it('describes merged branches without the generic no-changes copy', () => {
    setup()
    expect(describeReviewNoBranchChanges('MERGED', 'origin/main')).toBe('Merged PR has no remaining changes vs origin/main')
  })

  it('falls back to the generic no-changes copy for open branches', () => {
    setup()
    expect(describeReviewNoBranchChanges('OPEN', 'origin/main')).not.toContain('Merged')
  })
})

describe('filterReviewPrs', () => {
  const prs = [
    { number: 12, title: 'Fix login flow', headRefName: 'feat/login', baseRefName: 'main', author: { login: 'alice' }, state: 'OPEN' },
    { number: 34, title: 'Refactor payments', headRefName: 'feat/pay', baseRefName: 'main', author: { login: 'bob' }, state: 'MERGED' },
  ]

  it('filters PRs by metadata', () => {
    expect(filterReviewPrs(prs, 'pay')).toHaveLength(1)
    expect(filterReviewPrs(prs, 'alice')).toHaveLength(1)
    expect(filterReviewPrs(prs, 'merged')).toHaveLength(1)
  })

  it('returns all PRs for an empty query', () => {
    expect(filterReviewPrs(prs, '  ')).toHaveLength(2)
  })
})

describe('getFileState', () => {
  it('detects added files', () => {
    expect(getFileState('diff --git a/x b/x\nnew file mode 100644\n')).toBe('A')
  })

  it('detects deleted files', () => {
    expect(getFileState('diff --git a/x b/x\ndeleted file mode 100644\n')).toBe('D')
  })

  it('defaults to modified', () => {
    expect(getFileState('diff --git a/x b/x\n@@ -1 +1 @@\n')).toBe('M')
  })
})

describe('relativeTime', () => {
  it('reports just now for very recent timestamps', () => {
    expect(relativeTime(new Date().toISOString())).toBe('just now')
  })

  it('reports minutes ago', () => {
    expect(relativeTime(new Date(Date.now() - 5 * 60000).toISOString())).toBe('5m ago')
  })
})

describe('wordDiff', () => {
  it('marks added and removed words at the word level', () => {
    const { oldHtml, newHtml } = wordDiff('hello world', 'hello there')
    expect(oldHtml).toContain('<mark class="sh-word-del">world</mark>')
    expect(newHtml).toContain('<mark class="sh-word-add">there</mark>')
    expect(oldHtml).toContain('hello')
  })

  it('falls back to plain escaped text for very long inputs', () => {
    const long = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ')
    const { oldHtml, newHtml } = wordDiff(long, long)
    expect(oldHtml).not.toContain('<mark')
    expect(newHtml).not.toContain('<mark')
  })
})

describe('esc', () => {
  it('escapes html-significant characters', () => {
    expect(esc('<a>&"b"</a>')).toBe('&lt;a&gt;&amp;"b"&lt;/a&gt;')
  })
})

describe('highlightCode', () => {
  it('highlights keywords, strings and comments for known extensions', () => {
    const html = highlightCode('const x = "hi" // note', 'ts')
    expect(html).toContain('sh-keyword">const</span>')
    expect(html).toContain('sh-string">"hi"</span>')
    expect(html).toContain('sh-comment">// note</span>')
  })

  it('escapes but does not tokenize unknown extensions', () => {
    expect(highlightCode('<b>const</b>', 'weirdext')).toBe('&lt;b&gt;const&lt;/b&gt;')
  })
})
