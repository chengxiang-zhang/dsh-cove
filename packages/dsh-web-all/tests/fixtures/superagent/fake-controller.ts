/**
 * Fake session controller: implements SessionControllerFace in memory.
 * Records every call, lets the test push session events with `emit`, and can be
 * told to fail `create` or `prompt`.
 */

import type { SessionControllerFace } from '../../../src/host/services/superagent/host-ports.ts'

export type ControllerCall =
  | { method: 'create'; req: Parameters<SessionControllerFace['create']>[0] }
  | { method: 'prompt'; req: Parameters<SessionControllerFace['prompt']>[0] }
  | { method: 'cancel'; req: Parameters<SessionControllerFace['cancel']>[0] }
  | { method: 'inspect'; sessionId: string }

export interface FakeController extends SessionControllerFace {
  readonly calls: readonly ControllerCall[]
  emit(sessionId: string, event: unknown): void
  failCreate(error: Error | undefined): void
  failPrompt(error: Error | undefined): void
  /** Fails the next `times` creates with `error`, then succeeds again. */
  failCreateTimes(times: number, error: Error): void
}

interface Session { cwd?: string; events: unknown[] }

export function createFakeController(): FakeController {
  const calls: ControllerCall[] = []
  const sessions = new Map<string, Session>()
  let createError: Error | undefined
  let promptError: Error | undefined
  let createFailures = 0
  let createFailure: Error | undefined
  let seq = 0

  return {
    calls,
    async create(req) {
      calls.push({ method: 'create', req: { ...req } })
      if (createError !== undefined) throw createError
      if (createFailures > 0 && createFailure !== undefined) { createFailures -= 1; throw createFailure }
      const sessionId = req.sessionId ?? `fake-session-${++seq}`
      if (!sessions.has(sessionId)) sessions.set(sessionId, { cwd: req.cwd, events: [] })
      // S2: the host reports the preset it used, and a default one when none was asked for.
      return { sessionId, agentPreset: req.agentPreset ?? 'standard' }
    },
    async prompt(req, signal) {
      calls.push({ method: 'prompt', req: { ...req, content: [...req.content] } })
      if (signal.aborted) throw new Error('prompt aborted')
      if (promptError !== undefined) throw promptError
      if (!sessions.has(req.sessionId)) throw new Error(`unknown session ${req.sessionId}`)
      return { accepted: true }
    },
    cancel(req) {
      calls.push({ method: 'cancel', req: { ...req } })
      return undefined
    },
    async inspect(sessionId) {
      calls.push({ method: 'inspect', sessionId })
      const session = sessions.get(sessionId)
      if (session === undefined) throw new Error(`unknown session ${sessionId}`)
      return { meta: { cwd: session.cwd }, events: [...session.events] }
    },
    emit(sessionId, event) {
      const session = sessions.get(sessionId)
      if (session === undefined) throw new Error(`emit to unknown session ${sessionId}`)
      session.events.push(event)
    },
    failCreate(error) { createError = error },
    failPrompt(error) { promptError = error },
    failCreateTimes(times, error) { createFailures = times; createFailure = error },
  }
}
