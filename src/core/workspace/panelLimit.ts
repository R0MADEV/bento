// Some panel types are singletons by default (e.g. TV: playing two at once makes
// no sense). The user can unlock multiples per type. This decides whether one
// more panel of a type may be added.

export interface PanelLimitInput {
  singleton: boolean
  unlocked: boolean
  alreadyExists: boolean
}

export function canAddPanel({ singleton, unlocked, alreadyExists }: PanelLimitInput): boolean {
  if (!singleton) return true
  if (unlocked) return true
  return !alreadyExists
}
