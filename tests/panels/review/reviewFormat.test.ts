import { describe, expect, it, vi } from 'vitest'
import { makeLocalStorage } from '../../helpers/localStorage'
import {
  describeReviewNoBranchChanges,
  describeReviewPrState,
  describeReviewStaleness,
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
    expect(html).toContain('hljs-keyword">const</span>')
    expect(html).toContain('hljs-string">&quot;hi&quot;</span>')
    expect(html).toContain('hljs-comment">// note</span>')
  })

  it('highlights the languages the hand-written table never had', () => {
    // Un JSON, un CSS o un YAML salían en plano: la tabla eran cuatro
    // lenguajes escritos a mano y todo lo demás quedaba fuera.
    expect(highlightCode('{"clave": 1}', 'json')).toContain('hljs-')
    expect(highlightCode('.a { color: red }', 'css')).toContain('hljs-')
    expect(highlightCode('SELECT * FROM t', 'sql')).toContain('hljs-')
  })

  it('keeps the code intact once the tags are taken out', () => {
    // Perder un carácter al colorear es peor que no colorear.
    const code = 'const x = obj?.[k] ?? `a${b}`'
    const text = highlightCode(code, 'ts').replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'").replace(/&amp;/g, '&')

    expect(text).toBe(code)
  })

  it('escapes but does not tokenize unknown extensions', () => {
    expect(highlightCode('<b>const</b>', 'weirdext')).toBe('&lt;b&gt;const&lt;/b&gt;')
  })
})

describe('describeReviewStaleness', () => {
  it('avisa cuando el código se movió debajo de la review', () => {
    setup()
    // El commit se guarda con la review precisamente para esto; hasta ahora
    // se estampaba y no lo miraba nadie.
    expect(describeReviewStaleness('abc1234567', 'def7654321')).toContain('abc1234')
  })

  it('calla cuando la review es del commit que hay', () => {
    setup()
    expect(describeReviewStaleness('abc1234567', 'abc1234567')).toBeNull()
  })

  it('calla también cuando falta alguno de los dos', () => {
    setup()
    // No haber podido leer el sha no es prueba de que nada cambiara.
    expect(describeReviewStaleness('', 'def7654321')).toBeNull()
    expect(describeReviewStaleness('abc1234567', '')).toBeNull()
  })
})
