import { describe, it, expect } from 'vitest'
import { recipesRootFor } from '../../../src/core/docker/recipesDir'

describe('recipesRootFor', () => {
  it('keeps a folder that holds the recipes', () => {
    expect(recipesRootFor('/home/me/bento-recipes', 'konect-nixon')).toBe('/home/me/bento-recipes')
  })
  it('uses the parent when the picked folder is the project recipe itself', () => {
    expect(recipesRootFor('/home/me/bento-recipes/konect-nixon', 'konect-nixon')).toBe('/home/me/bento-recipes')
  })
  it('ignores a trailing slash', () => {
    expect(recipesRootFor('/home/me/bento-recipes/konect-nixon/', 'konect-nixon')).toBe('/home/me/bento-recipes')
  })
  it('keeps the folder when there is no project key', () => {
    expect(recipesRootFor('/home/me/bento-recipes', '')).toBe('/home/me/bento-recipes')
  })
})
