import { describe, expect, it } from 'vitest'
import { ReviewRunCollector } from '../../../src/panels/review/reviewEngineRun'

// The drawer renders runs; the engine reports events. Getting the boundaries
// wrong here means one agent's findings appear under another's name.

describe('ReviewRunCollector', () => {
  it('keeps each agent report under the stage it belongs to', () => {
    const collector = new ReviewRunCollector()

    collector.startStage('Agente 1/2 (claude)', 'claude')
    collector.append('hallazgo de claude')
    collector.startStage('Agente 2/2 (codex)', 'codex')
    collector.append('hallazgo de codex')
    collector.close()

    expect(collector.runs).toHaveLength(2)
    expect(collector.runs[0]).toMatchObject({ label: 'Agente 1/2 (claude)', report: 'hallazgo de claude' })
    expect(collector.runs[1]).toMatchObject({ label: 'Agente 2/2 (codex)', report: 'hallazgo de codex' })
  })

  it('labels the verification the way the panel always did', () => {
    const collector = new ReviewRunCollector()
    collector.startSynthesis('opencode')
    collector.append('informe final')
    collector.close()

    expect(collector.runs[0]).toMatchObject({ label: 'Síntesis final', agent: 'opencode' })
  })

  it('drops a stage that produced neither report nor error', () => {
    // An empty run would render as a heading with nothing under it.
    const collector = new ReviewRunCollector()
    collector.startStage('Agente 1/2 (claude)', 'claude')
    collector.close()

    expect(collector.runs).toHaveLength(0)
  })

  it('keeps a failed stage so the drawer can say what went wrong', () => {
    const collector = new ReviewRunCollector()
    collector.startStage('Agente 1/2 (claude)', 'claude')
    collector.fail('claude no encontrado', 'claude')
    collector.close()

    expect(collector.runs[0]).toMatchObject({ error: 'claude no encontrado' })
  })

  it('attributes an error with no stage open rather than losing it', () => {
    // The engine rejects an invalid base before any stage starts; that message
    // is the only thing the user gets.
    const collector = new ReviewRunCollector()
    collector.fail('rama base inválida', 'claude')
    collector.close()

    expect(collector.runs).toHaveLength(1)
    expect(collector.runs[0].error).toBe('rama base inválida')
  })

  it('attaches the session to the run in flight', () => {
    const collector = new ReviewRunCollector()
    collector.startSynthesis('codex')
    collector.append('final')
    collector.setSession('sess-9')
    collector.close()

    expect(collector.runs[0].sessionId).toBe('sess-9')
  })

  it('joins the chunks of one stage into a single report', () => {
    const collector = new ReviewRunCollector()
    collector.startStage('Agente 1/1 (claude)', 'claude')
    collector.append('primera parte ')
    collector.append('y segunda')
    collector.close()

    expect(collector.runs[0].report).toBe('primera parte y segunda')
  })

  it('closing twice does not duplicate the run', () => {
    const collector = new ReviewRunCollector()
    collector.startStage('Agente 1/1 (claude)', 'claude')
    collector.append('algo')
    collector.close()
    collector.close()

    expect(collector.runs).toHaveLength(1)
  })
})
