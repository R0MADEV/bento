// Extracts paths from a unified diff, preserving its displayed order.
export function diffFileNames(raw: string): string[] {
  return raw.split(/(?=^diff --git )/m).filter(Boolean).map(chunk => {
    const firstLine = chunk.split('\n')[0] ?? ''
    return firstLine.match(/^diff --git a\/(.+) b\//)?.[1] ?? firstLine
  })
}
