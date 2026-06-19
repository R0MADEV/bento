import { describe, it, expect } from 'vitest'
import { toggleFavorite, isFavorite } from '../../../src/core/channel/favorites'

describe('toggleFavorite', () => {
  it('adds an id that is not present', () => {
    expect(toggleFavorite([], 'a')).toEqual(['a'])
  })

  it('removes an id that is already present', () => {
    expect(toggleFavorite(['a', 'b'], 'a')).toEqual(['b'])
  })

  it('does not mutate the original array', () => {
    const original = ['a']
    toggleFavorite(original, 'b')
    expect(original).toEqual(['a'])
  })
})

describe('isFavorite', () => {
  it('returns true when present', () => {
    expect(isFavorite(['a', 'b'], 'b')).toBe(true)
  })

  it('returns false when absent', () => {
    expect(isFavorite(['a'], 'z')).toBe(false)
  })
})
