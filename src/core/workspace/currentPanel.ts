export function currentPanelIndex(
  panels: readonly { id: string }[],
  activeElement: Element | null,
  panelElement: (id: string) => Element | undefined,
  activePanelId: string | null | undefined,
): number {
  const byFocus = panels.findIndex(p => panelElement(p.id)?.contains(activeElement) ?? false)
  if (byFocus >= 0) return byFocus
  return panels.findIndex(p => p.id === activePanelId)
}
