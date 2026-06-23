export interface OpenApiEndpoint {
  method: string
  url: string
  summary: string
  body: string
  headers: string
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']

// Base URL: OpenAPI 3 servers[0].url, else Swagger 2 schemes+host+basePath.
// A relative server URL (e.g. "/api/v3") is resolved against the spec URL's origin.
function baseUrl(spec: Record<string, unknown>, specUrl: string): string {
  const server = (spec.servers as { url?: string }[] | undefined)?.[0]?.url
  if (server) {
    if (/^https?:\/\//.test(server)) return server.replace(/\/$/, '')
    try { return (new URL(specUrl).origin + server).replace(/\/$/, '') } catch { return server.replace(/\/$/, '') }
  }
  const host = spec.host as string | undefined
  if (host) {
    const scheme = (spec.schemes as string[] | undefined)?.[0] ?? 'https'
    const basePath = ((spec.basePath as string | undefined) ?? '').replace(/\/$/, '')
    return `${scheme}://${host}${basePath}`
  }
  return ''
}

type Schema = Record<string, unknown>
type Components = Record<string, Schema>

function components(spec: Record<string, unknown>): Components {
  const c = spec.components as { schemas?: Components } | undefined
  return c?.schemas ?? (spec.definitions as Components) ?? {}
}

// A sample value matching a JSON schema (resolving $ref against components).
function exampleFromSchema(schema: Schema | undefined, refs: Components, depth = 0): unknown {
  if (!schema || depth > 6) return null
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.split('/').pop() ?? ''
    return exampleFromSchema(refs[name], refs, depth + 1)
  }
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum)) return schema.enum[0]
  switch (schema.type) {
    case 'object': {
      const out: Record<string, unknown> = {}
      const props = (schema.properties as Record<string, Schema>) ?? {}
      for (const [k, v] of Object.entries(props)) out[k] = exampleFromSchema(v, refs, depth + 1)
      return out
    }
    case 'array':
      return [exampleFromSchema(schema.items as Schema, refs, depth + 1)]
    case 'string':
      // Binary uploads can't be pre-filled as text → omit them.
      if (schema.format === 'binary' || schema.format === 'byte') return undefined
      return schema.format === 'date-time' ? '2024-01-01T00:00:00Z' : ''
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return false
    default:
      return null
  }
}

// JSON body for an operation: explicit example, else generated from the schema.
function operationBody(operation: Record<string, unknown>, refs: Components): string {
  const content = (operation.requestBody as { content?: Record<string, { example?: unknown; schema?: Schema }> } | undefined)?.content
  // Prefer JSON, else the first declared media type (xml, form…).
  const media = content?.['application/json'] ?? (content ? Object.values(content)[0] : undefined)
  // Swagger 2: a "body" parameter carries the schema instead of requestBody.
  const bodyParam = (operation.parameters as { in?: string; schema?: Schema }[] | undefined)?.find(p => p.in === 'body')

  let example = media?.example
  if (example === undefined && media?.schema) example = exampleFromSchema(media.schema, refs)
  if (example === undefined && bodyParam?.schema) example = exampleFromSchema(bodyParam.schema, refs)
  return example === undefined ? '' : JSON.stringify(example, null, 2)
}

// Header parameters declared on the operation, as "Name: value" lines.
function operationHeaders(operation: Record<string, unknown>): string {
  const params = (operation.parameters as { name?: string; in?: string; example?: unknown }[] | undefined) ?? []
  return params
    .filter(p => p.in === 'header' && p.name)
    .map(p => `${p.name}: ${p.example ?? ''}`)
    .join('\n')
}

// A readable name for the spec: info.title, else the host, else "API".
export function specTitle(spec: unknown): string {
  if (typeof spec !== 'object' || spec === null) return 'API'
  const s = spec as Record<string, unknown>
  const title = (s.info as { title?: string } | undefined)?.title
  return title || (s.host as string | undefined) || 'API'
}

// Flatten an OpenAPI/Swagger spec into a list of callable endpoints.
export function parseOpenApi(spec: unknown, specUrl = ''): OpenApiEndpoint[] {
  if (typeof spec !== 'object' || spec === null) return []
  const s = spec as Record<string, unknown>
  const paths = s.paths as Record<string, Record<string, unknown>> | undefined
  if (!paths) return []

  const base = baseUrl(s, specUrl)
  const refs = components(s)
  const endpoints: OpenApiEndpoint[] = []
  for (const [path, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const operation = item[method] as Record<string, unknown> | undefined
      if (!operation) continue
      endpoints.push({
        method: method.toUpperCase(),
        url: `${base}${path}`,
        summary: (operation.summary as string) || (operation.operationId as string) || '',
        body: operationBody(operation, refs),
        headers: operationHeaders(operation),
      })
    }
  }
  return endpoints
}
