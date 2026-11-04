/**
 * Responder watchdog contracts.
 *
 * The case these exist for is real: a plugin reload was aborted halfway, the
 * domain's teardown had already disposed the responder, and the replacement never
 * ran. The bot kept its connection and its queue and answered nobody.
 *
 * What must not happen is the watchdog turning that into a loop, or hiding it.
 */

import { describe, expect, it, vi } from 'vitest'
import { REPAIR_COOLDOWN_MS, createResponderWatchdog } from '../src/host/services/lark-inbox/responder-watchdog.ts'

/** A watchdog over mutable flags, so a test can express "the repair worked". */
function harness(options: { expected?: boolean; present?: boolean; repairWorks?: boolean } = {}) {
  const state = {
    expected: options.expected ?? true,
    present: options.present ?? false,
    repairWorks: options.repairWorks ?? true,
  }
  const warn = vi.fn()
  const repair = vi.fn(() => {
    if (state.repairWorks) state.present = true
  })
  const watchdog = createResponderWatchdog({
    expected: () => state.expected,
    present: () => state.present,
    repair,
    log: { warn },
  })
  return { watchdog, state, warn, repair }
}

describe('responder watchdog', () => {
  it('does nothing while the responder is attached', () => {
    const { watchdog, repair } = harness({ present: true })
    expect(watchdog.check(1000)).toBe('idle')
    expect(repair).not.toHaveBeenCalled()
  })

  it('does nothing when no runtime is mounted', () => {
    const { watchdog, repair } = harness({ expected: false })
    expect(watchdog.check(1000)).toBe('idle')
    expect(repair).not.toHaveBeenCalled()
  })

  it('repairs a missing responder and says so', () => {
    const { watchdog, warn, repair } = harness()
    expect(watchdog.check(1000)).toBe('repaired')
    expect(repair).toHaveBeenCalledTimes(1)
    // Loud on purpose: the operator's reload did not land and they should know.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('自动重建')
  })

  it('stops trying for a while after a repair that did not take', () => {
    const { watchdog, repair } = harness({ repairWorks: false })
    expect(watchdog.check(1000)).toBe('skipped')
    expect(watchdog.check(2000)).toBe('skipped')
    expect(repair).toHaveBeenCalledTimes(1)

    // Past the cooldown it is worth another attempt.
    expect(watchdog.check(1000 + REPAIR_COOLDOWN_MS + 1)).toBe('skipped')
    expect(repair).toHaveBeenCalledTimes(2)
  })

  it('reports a repair that threw instead of swallowing it', () => {
    const state = { present: false }
    const warn = vi.fn()
    const watchdog = createResponderWatchdog({
      expected: () => true,
      present: () => state.present,
      repair: () => { throw new Error('sessionController 不可用') },
      log: { warn },
    })
    expect(watchdog.check(1000)).toBe('skipped')
    expect(String(warn.mock.calls[0]?.[0])).toContain('sessionController 不可用')
  })
})
