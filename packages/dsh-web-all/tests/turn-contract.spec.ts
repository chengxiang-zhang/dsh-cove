import { afterEach, describe, expect, it } from 'vitest'
import {
  apply,
  isLaunchQuestion,
  runsReleaseGate,
  shouldSteer,
  steerText,
} from '../presets/code-vibe/plugins/turn-contract.js'

type Handler = (payload: any) => void

function fakeRuntime() {
  const rootHandlers = new Map<string, Handler>()
  const agentHandlers = new Map<string, Handler>()
  const steered: any[] = []
  const agent = {
    session: { header: {} as Record<string, unknown> },
    ctx: {
      on(event: string, handler: Handler) {
        agentHandlers.set(event, handler)
        return () => agentHandlers.delete(event)
      },
    },
    steer(message: any) {
      steered.push(message)
    },
  }
  const ctx = {
    on(event: string, handler: Handler) {
      rootHandlers.set(event, handler)
      return () => rootHandlers.delete(event)
    },
  }
  return {
    ctx,
    agent,
    steered,
    create() {
      rootHandlers.get('agent/created')?.({ agent })
    },
    userMessage(text: string) {
      agentHandlers.get('agent/inbox/claimed')?.({
        message: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
      })
    },
    toolResult(name: string, command: string) {
      agentHandlers.get('tools/result')?.({ name, arguments: JSON.stringify({ command }) })
    },
    readyToStop() {
      agentHandlers.get('agent/turn-stopping')?.({ agent })
    },
  }
}

afterEach(() => {
  delete process.env.TURN_CONTRACT_STEER
})

describe('turn contract', () => {
  it('recognizes launch and close questions, and rejects negations', () => {
    for (const text of ['具备全量上线的条件了吗', '上线前检查有什么问题', '可以发了吗', '上生产还差什么', '现在能收尾吗']) {
      expect(isLaunchQuestion(text), text).toBe(true)
    }
    for (const text of ['不要上线，先看看', '写一个订单页面', '把这个 bug 修了', '']){
      expect(isLaunchQuestion(text), text).toBe(false)
    }
  })

  it('only treats an executed release_check.py command as gate evidence', () => {
    expect(runsReleaseGate('python3 presets/.../release_check.py /ws W1 --run')).toBe(true)
    expect(runsReleaseGate('journey.sh --authorize-deploy --by 张呈祥 --quote 可以上')).toBe(false)
    expect(runsReleaseGate('cat release_check.py')).toBe(true)
    expect(runsReleaseGate('')).toBe(false)
  })

  it('steers exactly once when a launch turn stops without the gate', () => {
    const rt = fakeRuntime()
    apply(rt.ctx as any)
    rt.create()

    rt.userMessage('具备全量上线的条件了吗')
    rt.readyToStop()
    expect(rt.steered).toHaveLength(1)
    expect(String(rt.steered[0].content[0].text)).toContain('release_check.py')
    expect(String(rt.steered[0].content[0].text)).toContain('禁止用散文结论代替表')

    rt.readyToStop()
    expect(rt.steered).toHaveLength(1)
  })

  it('does not steer once the gate has run in that turn', () => {
    const rt = fakeRuntime()
    apply(rt.ctx as any)
    rt.create()

    rt.userMessage('上线前检查还有什么问题')
    rt.toolResult('bash', 'python3 .../release_check.py /ws W1 --run')
    rt.readyToStop()
    expect(rt.steered).toHaveLength(0)
  })

  it('stays silent on ordinary development turns', () => {
    const rt = fakeRuntime()
    apply(rt.ctx as any)
    rt.create()

    rt.userMessage('把订单页的空态补上')
    rt.readyToStop()
    expect(rt.steered).toHaveLength(0)
  })

  it('stays silent inside a delegated subagent', () => {
    const rt = fakeRuntime()
    rt.agent.session.header = { origin: 'subagent' }
    apply(rt.ctx as any)
    rt.create()

    rt.userMessage('能不能上线了')
    rt.readyToStop()
    expect(rt.steered).toHaveLength(0)
  })

  it('can be switched off with TURN_CONTRACT_STEER=0', () => {
    const rt = fakeRuntime()
    process.env.TURN_CONTRACT_STEER = '0'
    apply(rt.ctx as any)
    rt.create()

    rt.userMessage('能上线了吗')
    rt.readyToStop()
    expect(rt.steered).toHaveLength(0)
  })

  it('keeps the pure decision and text small enough to stay actionable', () => {
    expect(shouldSteer({ launchTurn: true, gateRan: false, steers: 0 })).toBe(true)
    expect(shouldSteer({ launchTurn: true, gateRan: true, steers: 0 })).toBe(false)
    expect(shouldSteer({ launchTurn: true, gateRan: false, steers: 1 })).toBe(false)
    expect(shouldSteer(null)).toBe(false)
    expect(steerText().length).toBeLessThan(600)
  })
})