import { describe, it, expect } from 'vitest'
import { parseOpenApi } from '../../../src/core/http/openapi'

describe('parseOpenApi', () => {
  it('extracts method, url and summary', () => {
    const spec = {
      servers: [{ url: 'https://api.example.com/v1' }],
      paths: { '/users': { get: { summary: 'List users' } } },
    }
    const e = parseOpenApi(spec)[0]
    expect(e.method).toBe('GET')
    expect(e.url).toBe('https://api.example.com/v1/users')
    expect(e.summary).toBe('List users')
  })

  it('uses an explicit requestBody example for the body', () => {
    const spec = {
      paths: { '/u': { post: { requestBody: { content: { 'application/json': { example: { name: 'Ada' } } } } } } },
    }
    expect(parseOpenApi(spec)[0].body).toBe('{\n  "name": "Ada"\n}')
  })

  it('generates the body from the schema when there is no example', () => {
    const spec = {
      paths: {
        '/u': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' }, ok: { type: 'boolean' } } },
                },
              },
            },
          },
        },
      },
    }
    expect(parseOpenApi(spec)[0].body).toBe('{\n  "name": "",\n  "age": 0,\n  "ok": false\n}')
  })

  it('resolves a $ref against components.schemas', () => {
    const spec = {
      components: { schemas: { Pet: { type: 'object', properties: { id: { type: 'integer' } } } } },
      paths: { '/pet': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } } },
    }
    expect(parseOpenApi(spec)[0].body).toBe('{\n  "id": 0\n}')
  })

  it('falls back to the first content type when there is no application/json', () => {
    const spec = {
      paths: { '/u': { post: { requestBody: { content: { 'application/xml': { schema: { type: 'object', properties: { id: { type: 'integer' } } } } } } } } },
    }
    expect(parseOpenApi(spec)[0].body).toBe('{\n  "id": 0\n}')
  })

  it('leaves the body empty for binary uploads', () => {
    const spec = {
      paths: { '/img': { post: { requestBody: { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } } } },
    }
    expect(parseOpenApi(spec)[0].body).toBe('')
  })

  it('imports header parameters into the endpoint headers', () => {
    const spec = {
      paths: { '/x': { get: { parameters: [{ name: 'X-Api-Key', in: 'header', example: 'abc' }, { name: 'q', in: 'query' }] } } },
    }
    expect(parseOpenApi(spec)[0].headers).toBe('X-Api-Key: abc')
  })

  it('resolves a relative server URL against the spec URL', () => {
    const spec = { servers: [{ url: '/api/v3' }], paths: { '/pet': { get: {} } } }
    expect(parseOpenApi(spec, 'https://petstore3.swagger.io/api/v3/openapi.json')[0].url)
      .toBe('https://petstore3.swagger.io/api/v3/pet')
  })

  it('builds the base URL from a Swagger 2 host/basePath/schemes', () => {
    const spec = { host: 'api.example.com', basePath: '/v2', schemes: ['https'], paths: { '/ping': { get: {} } } }
    expect(parseOpenApi(spec)[0].url).toBe('https://api.example.com/v2/ping')
  })

  it('returns [] for a spec without paths', () => {
    expect(parseOpenApi({})).toEqual([])
    expect(parseOpenApi(null)).toEqual([])
  })
})
