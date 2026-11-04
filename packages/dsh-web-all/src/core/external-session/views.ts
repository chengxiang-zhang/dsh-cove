/**
 * Projections from stored records to the shapes the two consumers read.
 *
 * The panel wants a timeline it can render while a turn is still running; the
 * model-facing list wants a compact state row. Neither is the persisted record,
 * so both are derived here once instead of being re-imagined per surface. This
 * is also where the running state lives: a turn only becomes a record when it
 * settles, so a live turn is passed in from engine state rather than stored.
 * @module dsh-web-all/core/external-session/views
 */
import {
  canResumeSession,
  type ExternalLiveTurn, type ExternalSessionOverview, type ExternalSessionOverviewList,
  type ExternalSessionRecord, type ExternalSessionView, type ExternalTurnDigest,
  type ExternalTurnRecord, type ExternalTurnView, type ExternalUsage,
} from './types.ts'

/** Project one settled turn for the timeline. */
export function toTurnView(turn: ExternalTurnRecord): ExternalTurnView {
  const view: ExternalTurnView = {
    n: turn.n,
    prompt: turn.prompt,
    status: turn.status,
    startedAt: turn.startedAt,
    durationMs: turn.durationMs,
    result: turn.result,
  }
  if (turn.usage !== undefined) view.usage = turn.usage
  if (turn.costUsd !== undefined) view.costUsd = turn.costUsd
  return view
}

/** Project a turn that is running now; it has no result or duration yet. */
export function toLiveTurnView(turn: ExternalLiveTurn): ExternalTurnView {
  return { n: turn.n, prompt: turn.prompt, status: 'running', startedAt: turn.startedAt }
}

/**
 * Project one session for the panel.
 * @param session - the stored record.
 * @param liveTurn - the turn running now, when there is one.
 * @returns the view the panel renders; `canContinue` decides whether the follow-up action is offered.
 */
export function toSessionView(session: ExternalSessionRecord, liveTurn?: ExternalLiveTurn): ExternalSessionView {
  const turns = session.turns.map(toTurnView)
  if (liveTurn !== undefined) turns.push(toLiveTurnView(liveTurn))
  return {
    id: session.id,
    provider: session.provider,
    title: session.title,
    status: session.status,
    cwd: session.cwd,
    createdAt: session.createdAt,
    lastTurnAt: session.lastTurnAt,
    canContinue: canResumeSession(session),
    turns,
  }
}

/** Project every session, taking live turns from one lookup. */
export function toSessionList(
  sessions: readonly ExternalSessionRecord[],
  liveTurns: ReadonlyMap<string, ExternalLiveTurn> = new Map(),
): ExternalSessionView[] {
  return sessions.map(session => {
    const live = liveTurns.get(session.id)
    return live === undefined ? toSessionView(session) : toSessionView(session, live)
  })
}

/** Project the compact digest of the last settled turn. */
export function toTurnDigest(turn: ExternalTurnRecord): ExternalTurnDigest {
  return {
    n: turn.n,
    status: turn.status,
    durationMs: turn.durationMs,
    usage: turn.usage ?? null,
    costUsd: turn.costUsd ?? null,
  }
}

/** Project one session for the model-facing list tool. */
export function toSessionOverview(session: ExternalSessionRecord): ExternalSessionOverview {
  const last = session.turns[session.turns.length - 1]
  return {
    id: session.id,
    provider: session.provider,
    title: session.title,
    status: session.status,
    cwd: session.cwd,
    createdAt: session.createdAt,
    lastTurnAt: session.lastTurnAt,
    canContinue: canResumeSession(session),
    turnCount: session.turns.length,
    lastTurn: last === undefined ? null : toTurnDigest(last),
  }
}

/** Project the model-facing list. */
export function toSessionOverviewList(sessions: readonly ExternalSessionRecord[]): ExternalSessionOverviewList {
  return { sessions: sessions.map(toSessionOverview) }
}

/** Normalize a CLI-reported usage for the tool result, which uses null for absent. */
export function usageOrNull(usage: ExternalUsage | undefined): ExternalUsage | null {
  return usage ?? null
}