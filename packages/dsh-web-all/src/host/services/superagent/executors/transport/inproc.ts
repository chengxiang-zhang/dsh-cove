/**
 * In-process executor transport: the historical behaviour behind the transport
 * interface.
 *
 * It wraps the host's `sessionController` service, so an executor session is created
 * in this process. The host event bus already forwards `session/event` into
 * `onSessionEvent`, which is why `watch` returns a no-op here.
 */

import type { SessionControllerFace } from '../../host-ports.ts'
import { parseSessionEvent } from '../events.ts'
import type { ExecutorCreateRequest, ExecutorCreateResult, ExecutorEventLike, ExecutorSnapshot, ExecutorTransport } from './types.ts'

/** Same rejection shape reconcile uses: an answer that says the session does not exist. */
const MISSING_SESSION = /unknown session|not found|no such|does not exist|missing session/iu

const PROMPT_TIMEOUT_MS = 60_000

export function createInprocTransport(controller: () => SessionControllerFace): ExecutorTransport {
  async function snapshot(sessionId: string): Promise<ExecutorSnapshot> {
    let events: readonly unknown[]
    let cwd: string | undefined
    try {
      const inspection = await controller().inspect(sessionId)
      events = inspection.events ?? []
      cwd = typeof inspection.meta?.cwd === 'string' ? inspection.meta.cwd : undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (MISSING_SESSION.test(message)) return { exists: false, running: false, cursor: 0, events: [] }
      throw error
    }
    const parsed = events.map(parseSessionEvent).filter((event): event is NonNullable<typeof event> => event !== undefined)
    const mapped: ExecutorEventLike[] = parsed.map(event => ({ type: event.type, seq: event.seq, ...(event.time === undefined ? {} : { time: event.time }), data: event.data }))
    let open = false
    for (const event of mapped) {
      if (event.type === 'turn/start') open = true
      else if (event.type === 'turn/end') open = false
    }
    const cursor = mapped.reduce((max, event) => (event.seq > max ? event.seq : max), 0)
    return { exists: true, running: open, cursor, events: mapped, ...(cwd === undefined ? {} : { cwd }) }
  }

  async function create(req: ExecutorCreateRequest): Promise<ExecutorCreateResult> {
    const created = await controller().create({
      sessionId: req.sessionId,
      cwd: req.cwd,
      ...(req.preset === undefined ? {} : { agentPreset: req.preset }),
    })
    const reported = created as { sessionId?: unknown; agentPreset?: unknown }
    return {
      sessionId: typeof reported.sessionId === 'string' ? reported.sessionId : req.sessionId,
      ...(typeof reported.agentPreset === 'string' ? { agentPreset: reported.agentPreset } : {}),
    }
  }

  return {
    kind: 'inproc',
    create,
    async prompt(req) {
      await controller().prompt({
        requestId: req.requestId,
        sessionId: req.sessionId,
        mode: req.mode,
        content: [{ type: 'text', text: req.text }],
      }, AbortSignal.timeout(PROMPT_TIMEOUT_MS))
    },
    async cancel(sessionId) {
      await controller().cancel({ sessionId })
    },
    snapshot,
    watch() {
      // The host event bus forwards `session/event` for local sessions already.
      return () => undefined
    },
    dispose() {
      // Nothing is owned here.
    },
  }
}