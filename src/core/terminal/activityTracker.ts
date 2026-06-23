export interface ActivityTracker {
  setBase(title: string): void
  onOutput(hasFocus: boolean): void
  onFocus(): void
}

export function createActivityTracker(onTitle: (title: string) => void): ActivityTracker {
  let base: string | undefined
  let active = false

  const push = () => { if (base !== undefined) onTitle(active ? `${base} ●` : base) }

  return {
    setBase(title: string) {
      base = title
      active = false
      push()
    },
    onOutput(hasFocus: boolean) {
      if (hasFocus || active) return
      active = true
      push()
    },
    onFocus() {
      if (!active) return
      active = false
      push()
    },
  }
}
