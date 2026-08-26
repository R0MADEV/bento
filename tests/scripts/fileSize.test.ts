import { describe, expect, it } from 'vitest'
import { implementationLines, overBudget } from '../../scripts/lib/fileSize.mjs'

describe('implementationLines', () => {
  it('counts every line of a plain file', () => {
    expect(implementationLines('a.ts', 'const a = 1\nconst b = 2\n')).toBe(2)
  })

  it('stops counting a Rust file at its inline test module', () => {
    // En Rust los tests van en el mismo fichero: contarlos castigaría a quien
    // los escribe, que es justo lo contrario de lo que queremos.
    const rust = 'fn a() {}\nfn b() {}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() {}\n}\n'
    expect(implementationLines('a.rs', rust)).toBe(2)
  })

  it('ignores blank lines and comment-only lines', () => {
    expect(implementationLines('a.ts', 'const a = 1\n\n// un comentario\n/// doc\nconst b = 2\n')).toBe(2)
  })
})

describe('overBudget', () => {
  const budget = 400

  it('flags a file that crosses the budget', () => {
    expect(overBudget([{ path: 'big.ts', lines: 401 }], {}, budget)).toEqual([
      { path: 'big.ts', lines: 401, allowed: 0, reason: 'nuevo' },
    ])
  })

  it('lets a known offender stay at its baseline size', () => {
    expect(overBudget([{ path: 'legacy.ts', lines: 900 }], { 'legacy.ts': 900 }, budget)).toEqual([])
  })

  it('flags a known offender that grows', () => {
    expect(overBudget([{ path: 'legacy.ts', lines: 901 }], { 'legacy.ts': 900 }, budget)).toEqual([
      { path: 'legacy.ts', lines: 901, allowed: 900, reason: 'ha crecido' },
    ])
  })

  it('says nothing about files under the budget', () => {
    expect(overBudget([{ path: 'small.ts', lines: 399 }], {}, budget)).toEqual([])
  })
})
