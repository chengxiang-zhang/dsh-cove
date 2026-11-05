/**
 * Scripted agent (T30): the fake session controller with a "model" that follows a
 * script. Scripts are data, one entry per turn or step; there is no judgement here.
 *
 * - Desk sessions (`sa-desk-*`): each prompt takes the next queued desk script and
 *   calls the registered desk tools in order, then ends the turn.
 * - Executor sessions (`sa-x-*`): the first prompt opens turn 1; a prompt carrying
 *   `[sa-input:...]` markers lands as a `user/message` inside the open turn, which is
 *   how the host records the consuming turn. `run` plays tool calls, the report and
 *   the turn end.
 * Events use the W0 spike shapes: `{ type, seq, time, data }`, exit codes as the
 * `[exit code: N]` text marker only when non-zero.
 */

import type { SessionControllerFace } from '../../../src/host/services/superagent/host-ports.ts'
import type { DeskTool } from '../../../src/host/services/superagent/desk/toolface.ts'
import type { ToolDefinitionLike } from '../../../src/host/services/superagent/executors/report-tool.ts'
import type { FakeController } from './fake-controller.ts'

export interface DeskStep {
  tool: string
  /** Input from what the turn's prompt carried: the batch event ids and the full text. */
  input: (turn: { eventIds: string[]; text: string }) => unknown
}

export type ExecutorStep =
  | { call: { name: string; args: Record<string, unknown>; output?: string; exit?: number } }
  | { report: Record<string, unknown> }
  | { end: string }

export interface ScriptedAgent {
  controller: SessionControllerFace
  /** Queue the script for the next desk turn. */
  desk(steps: DeskStep[]): void
  /** Play executor steps on a session. */
  run(sessionId: string, steps: ExecutorStep[]): Promise<void>
  /** Every desk tool result, in call order, with the tool name. */
  readonly results: { tool: string; result: unknown }[]
  /** Resolves once every scripted desk turn started so far has finished. */
  settle(): Promise<void>
}

export function createScriptedAgent(opts: {
  base: FakeController
  deskTools: (sessionId: string) => readonly DeskTool[] | undefined
  report: () => ToolDefinitionLike | undefined
  emit: (sessionId: string, event: unknown) => void
  now: () => number
}): ScriptedAgent {
  const queue: DeskStep[][] = []
  const results: ScriptedAgent['results'] = []
  const inflight = new Set<Promise<void>>()
  let seq = 0
  const turns = new Map<string, { turn: number; open: boolean }>()
  const emit = (sid: string, type: string, data: Record<string, unknown>): void => opts.emit(sid, { type, seq: ++seq, time: opts.now(), data })

  function openTurn(sid: string): number {
    const t = turns.get(sid) ?? { turn: 0, open: false }
    if (!t.open) { t.turn += 1; t.open = true; turns.set(sid, t); emit(sid, 'turn/start', { turn: t.turn }) }
    return t.turn
  }
  function endTurn(sid: string, kind: string): void {
    const t = turns.get(sid)
    if (!t?.open) return
    t.open = false
    emit(sid, 'turn/end', { turn: t.turn, reason: { kind } })
  }

  async function deskTurn(sid: string, text: string): Promise<void> {
    await new Promise(r => setImmediate(r))   // the desk has its waiter before the turn runs
    const steps = queue.shift() ?? []
    const eventIds = [...text.matchAll(/\[#(\S+) /g)].map(m => m[1])
    for (const step of steps) {
      const tool = opts.deskTools(sid)?.find(t => t.name === step.tool)
      if (!tool) throw new Error(`scripted desk: ${step.tool} is not registered on ${sid}`)
      results.push({ tool: step.tool, result: await tool.execute(step.input({ eventIds, text }), { sessionId: sid }) })
    }
    opts.emit(sid, { type: 'turn/end', seq: ++seq, time: opts.now(), data: { turn: 1, reason: { kind: 'completed' } } })
  }

  const base = opts.base
  const controller: SessionControllerFace = {
    create: req => base.create(req),
    cancel: req => base.cancel(req),
    inspect: id => base.inspect(id),
    async prompt(req, signal) {
      const out = await base.prompt(req, signal)
      const text = req.content.map(c => c.text).join('\n')
      if (req.sessionId.startsWith('sa-desk-')) {
        const p = deskTurn(req.sessionId, text).finally(() => inflight.delete(p))
        inflight.add(p)
      } else if (req.sessionId.startsWith('sa-x-')) {
        const turn = openTurn(req.sessionId)
        if (/\[sa-input:[^\]\s]+\]/.test(text)) emit(req.sessionId, 'user/message', { role: 'user', content: [{ type: 'text', text }], turn })
      }
      return out
    },
  }

  let callSeq = 0
  return {
    controller,
    desk: steps => { queue.push(steps) },
    results,
    async run(sid, steps) {
      for (const step of steps) {
        if ('call' in step) {
          const turn = openTurn(sid)
          const callId = `call-${++callSeq}`
          emit(sid, 'tool/call', { turn, step: 1, callId, name: step.call.name, arguments: JSON.stringify(step.call.args) })
          const marker = step.call.exit ? `\n[exit code: ${step.call.exit}]` : ''
          emit(sid, 'tool/result', { turn, step: 1, message: { toolCallId: callId, content: [{ type: 'text', text: `${step.call.output ?? 'ok'}${marker}` }], isError: false } })
        } else if ('report' in step) {
          const tool = opts.report()
          if (!tool) throw new Error('scripted executor: no report tool')
          tool.execute(step.report, { sessionId: sid })
        } else {
          endTurn(sid, step.end)
        }
      }
    },
    async settle() {
      while (inflight.size) await Promise.all([...inflight])
    },
  }
}
