import { describe, it, expect } from 'vitest'
import { keyToSequence } from '../../../src/core/terminal/keyToSequence'

const key = (k: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods } as KeyboardEvent)

describe('keyToSequence', () => {
  it('returns \\r for Enter', () => expect(keyToSequence(key('Enter'))).toBe('\r'))
  it('returns \\x7f for Backspace', () => expect(keyToSequence(key('Backspace'))).toBe('\x7f'))
  it('returns \\t for Tab', () => expect(keyToSequence(key('Tab'))).toBe('\t'))
  it('returns \\x1b for Escape', () => expect(keyToSequence(key('Escape'))).toBe('\x1b'))
  it('returns arrow sequence for ArrowUp', () => expect(keyToSequence(key('ArrowUp'))).toBe('\x1b[A'))
  it('returns arrow sequence for ArrowDown', () => expect(keyToSequence(key('ArrowDown'))).toBe('\x1b[B'))
  it('returns arrow sequence for ArrowRight', () => expect(keyToSequence(key('ArrowRight'))).toBe('\x1b[C'))
  it('returns arrow sequence for ArrowLeft', () => expect(keyToSequence(key('ArrowLeft'))).toBe('\x1b[D'))
  it('returns \\x03 for Ctrl+C', () => expect(keyToSequence(key('c', { ctrlKey: true }))).toBe('\x03'))
  it('returns \\x04 for Ctrl+D', () => expect(keyToSequence(key('d', { ctrlKey: true }))).toBe('\x04'))
  it('returns the char for printable keys', () => expect(keyToSequence(key('a'))).toBe('a'))
  it('returns null for modifier-only keys', () => expect(keyToSequence(key('Shift'))).toBeNull())
})
