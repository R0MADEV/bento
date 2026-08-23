import { describe, expect, it } from 'vitest'
import { pgFixIdents } from '../../../src/core/db/pgIdents'

describe('pgFixIdents', () => {
  it('leaves an all-lowercase name alone', () => {
    expect(pgFixIdents('SELECT * FROM users', ['users'])).toBe('SELECT * FROM users')
  })

  it('splits a wrongly quoted schema.table into two quoted parts', () => {
    expect(pgFixIdents('SELECT * FROM "public.client"', ['public.client']))
      .toBe('SELECT * FROM "public"."client"')
  })

  it('quotes a mixed-case table so Postgres does not lowercase it', () => {
    expect(pgFixIdents('SELECT * FROM Client', ['public.Client']))
      .toBe('SELECT * FROM "Client"')
  })

  it('quotes a qualified mixed-case name in full', () => {
    expect(pgFixIdents('SELECT * FROM public.Client', ['public.Client']))
      .toBe('SELECT * FROM "public"."Client"')
  })

  it('does not touch a name that is already quoted', () => {
    expect(pgFixIdents('SELECT * FROM "Client"', ['public.Client']))
      .toBe('SELECT * FROM "Client"')
  })

  it('ignores names it does not know', () => {
    expect(pgFixIdents('SELECT * FROM Unknown', ['public.Client']))
      .toBe('SELECT * FROM Unknown')
  })
})
