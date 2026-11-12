import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexCoordinatorRuntime } from '../src/host/services/superagent/executors/engines/codex-coordinator.ts'
import { runManagedTurn } from '../src/host/services/superagent/executors/managed-native.ts'

const consumed = { status: 'consumed', consumption: { turn_id: 'exact' } }
const completed = { id: 'exact', status: 'completed', items: [{ type: 'agentMessage', text: '{"ok":true}' }] }
afterEach(() => vi.useRealTimers())

for (const consumer of ['coordinator', 'managed'] as const) describe(consumer, () => {
  function setup(initial: unknown = consumed, initialTurns: unknown[] = [completed]) {
    vi.useFakeTimers()
    const launch = { expiresAt: Date.now() + 2000 }
    let turns = initialTurns
    const engine = {
      options: { outputSchema: {} }, io: { launch },
      execute: vi.fn(async () => initial), receiptFor: vi.fn(async () => consumed),
      turns: () => turns, cancel: vi.fn(async () => {})
    }
    const controller = new AbortController()
    const run = () => consumer === 'coordinator'
      ? new CodexCoordinatorRuntime(engine as never, x => x).run({ request_id: 'request', assignment_revision: 1, text: 'input' }, controller.signal)
      : runManagedTurn({ engine, launch } as never, 'input', 'request', 1, controller.signal)
    return { engine, launch, controller, run, setTurns: (value: unknown[]) => { turns = value } }
  }

  it('uses the authentic completed execute receipt without querying history again', async () => {
    const f = setup()
    const result = await f.run()
    expect(f.engine.receiptFor).not.toHaveBeenCalled()
    if (consumer === 'coordinator') expect(result).toEqual({ ok: true })
    else expect(result).toMatchObject({ receipt: consumed, turn: completed, answer: '{"ok":true}' })
  })

  it.each(['accepted', 'unknown', 'rejected'])('polls a %s initial receipt before returning', async status => {
    const f = setup({ status })
    const result = f.run()
    await vi.advanceTimersByTimeAsync(500)
    await result
    expect(f.engine.receiptFor).toHaveBeenCalledTimes(1)
  })

  it.each([{ turns: [] }, { turns: [{ ...completed, id: 'other' }] }, { turns: [{ ...completed, status: 'inProgress' }] }])('does not accept unmatched or incomplete turns %j', async ({ turns }) => {
    const f = setup(consumed, turns)
    const result = f.run()
    await vi.advanceTimersByTimeAsync(0)
    f.setTurns([completed])
    await vi.advanceTimersByTimeAsync(500)
    await result
    expect(f.engine.receiptFor).toHaveBeenCalledTimes(1)
  })

  it.each(['failed', 'interrupted'])('refuses an initial %s turn', async status => {
    const f = setup(consumed, [{ ...completed, status }])
    await expect(f.run()).rejects.toThrow(consumer === 'coordinator' ? 'COORDINATOR_TURN_FAILED' : 'MANAGED_TURN_' + status)
  })

  it('checks abort before accepting the initial receipt', async () => {
    const f = setup()
    f.controller.abort()
    await expect(f.run()).rejects.toThrow(consumer === 'coordinator' ? 'COORDINATOR_CANCELLED' : 'MANAGED_TURN_ABORTED')
    expect(f.engine.receiptFor).not.toHaveBeenCalled()
    expect(f.engine.cancel).toHaveBeenCalledTimes(consumer === 'coordinator' ? 1 : 0)
  })

  it('checks expiry before accepting the initial receipt', async () => {
    const f = setup()
    f.launch.expiresAt = Date.now()
    await expect(f.run()).rejects.toThrow('OUTCOME_UNKNOWN')
    expect(f.engine.receiptFor).not.toHaveBeenCalled()
  })

  it('never accepts a persistently unknown receipt', async () => {
    const f = setup({ status: 'unknown' })
    f.engine.receiptFor.mockResolvedValue({ status: 'unknown' } as never)
    const result = expect(f.run()).rejects.toThrow('OUTCOME_UNKNOWN')
    await vi.advanceTimersByTimeAsync(2000)
    await result
    expect(f.engine.receiptFor).toHaveBeenCalled()
  })
})
