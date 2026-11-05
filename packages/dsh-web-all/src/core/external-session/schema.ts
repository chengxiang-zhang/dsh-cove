/**
 * Structural validation for the external-session store file.
 *
 * The store is a single JSON file that outlives the host process, so reading it
 * is a trust boundary: a hand-edited or half-written file must be rejected as a
 * whole rather than partially imported, because a session record that silently
 * loses its `providerSessionId` would turn every later turn into a re-dispatch.
 *
 * Validation is strict about the fields this format defines and silent about
 * keys it does not know: the `version` field is the only breaking-change gate,
 * so a newer writer adding a field must not make an older reader discard the
 * file. Every rejection carries a reason naming the offending path.
 * @module dsh-web-all/core/external-session/schema
 */
import {
  EXTERNAL_STORE_VERSION, isExternalProvider, isExternalSessionStatus, isExternalTurnStatus,
  isExternalUsage, isInstant,
  type ExternalSessionRecord, type ExternalStoreFile, type ExternalTurnRecord,
} from './types.ts'

/** A parsed store, or the reason the input is not one. */
export type StoreParseResult =
  | { ok: true; value: ExternalStoreFile }
  | { ok: false; reason: string }

/** The empty store a first run starts from. */
export function emptyExternalStore(): ExternalStoreFile {
  return { version: EXTERNAL_STORE_VERSION, sessions: [] }
}

/** Serialize a store for the atomic write. */
export function serializeExternalStore(file: ExternalStoreFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

/** Parse store text; malformed JSON is a rejection, not a throw. */
export function parseExternalStoreText(text: string): StoreParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    return { ok: false, reason: `store is not valid JSON: ${String(error)}` }
  }
  return parseExternalStore(parsed)
}

/** Validate one already-decoded value as a store. */
export function parseExternalStore(input: unknown): StoreParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'store must be a JSON object' }
  }
  const file = input as Record<string, unknown>
  if (file.version !== EXTERNAL_STORE_VERSION) {
    return { ok: false, reason: `store version must be ${EXTERNAL_STORE_VERSION}, received ${JSON.stringify(file.version)}` }
  }
  if (!Array.isArray(file.sessions)) {
    return { ok: false, reason: 'store sessions must be an array' }
  }
  const sessions: ExternalSessionRecord[] = []
  const ids = new Set<string>()
  for (const [index, entry] of file.sessions.entries()) {
    const session = parseSession(entry, `sessions[${index}]`)
    if (typeof session === 'string') return { ok: false, reason: session }
    if (ids.has(session.id)) return { ok: false, reason: `sessions[${index}].id duplicates ${session.id}` }
    ids.add(session.id)
    sessions.push(session)
  }
  return { ok: true, value: { version: EXTERNAL_STORE_VERSION, sessions } }
}

/** One session record, or the reason it is not one. */
function parseSession(input: unknown, path: string): ExternalSessionRecord | string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return `${path} must be an object`
  }
  const session = input as Record<string, unknown>
  const id = nonEmptyString(session.id)
  if (id === null) return `${path}.id must be a non-empty string`
  if (!isExternalProvider(session.provider)) return `${path}.provider must be "claude" or "codex"`
  if (!isExternalSessionStatus(session.status)) return `${path}.status is not a session status`
  const cwd = nonEmptyString(session.cwd)
  if (cwd === null) return `${path}.cwd must be a non-empty string`
  const title = typeof session.title === 'string' ? session.title : null
  if (title === null) return `${path}.title must be a string`
  if (!isInstant(session.createdAt)) return `${path}.createdAt must be an ISO-8601 instant`
  if (!isInstant(session.lastTurnAt)) return `${path}.lastTurnAt must be an ISO-8601 instant`
  if (session.providerSessionId !== undefined) {
    if (nonEmptyString(session.providerSessionId) === null) return `${path}.providerSessionId must be a non-empty string when present`
  }
  if (!Array.isArray(session.turns)) return `${path}.turns must be an array`
  const turns: ExternalTurnRecord[] = []
  for (const [index, entry] of session.turns.entries()) {
    const turn = parseTurn(entry, `${path}.turns[${index}]`, index + 1)
    if (typeof turn === 'string') return turn
    turns.push(turn)
  }
  const record: ExternalSessionRecord = { id, provider: session.provider, cwd, title, status: session.status, createdAt: session.createdAt, lastTurnAt: session.lastTurnAt, turns }
  if (session.providerSessionId !== undefined) record.providerSessionId = session.providerSessionId as string
  return record
}

/** One turn record, or the reason it is not one. */
function parseTurn(input: unknown, path: string, expected: number): ExternalTurnRecord | string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return `${path} must be an object`
  }
  const turn = input as Record<string, unknown>
  // Turn numbers are the turn's identity inside a session and the panel's
  // ordering key: a gap or a repeat means the file was reordered or merged, and
  // continuing from it would report a wrong `turn` back to the model.
  if (turn.n !== expected) return `${path}.n must be ${expected}, received ${JSON.stringify(turn.n)}`
  if (typeof turn.prompt !== 'string') return `${path}.prompt must be a string`
  if (!isExternalTurnStatus(turn.status)) return `${path}.status is not a turn status`
  if (!isInstant(turn.startedAt)) return `${path}.startedAt must be an ISO-8601 instant`
  if (!isDuration(turn.durationMs)) return `${path}.durationMs must be a finite non-negative number`
  if (typeof turn.result !== 'string') return `${path}.result must be a string`
  if (turn.usage !== undefined && !isExternalUsage(turn.usage)) return `${path}.usage must hold finite non-negative input and output counts`
  if (turn.model !== undefined && nonEmptyString(turn.model) === null) return `${path}.model must be a non-empty string when present`
  if (turn.costUsd !== undefined && !isDuration(turn.costUsd)) return `${path}.costUsd must be a finite non-negative number`
  const record: ExternalTurnRecord = {
    n: expected,
    prompt: turn.prompt,
    status: turn.status,
    startedAt: turn.startedAt,
    durationMs: turn.durationMs,
    result: turn.result,
  }
  if (turn.usage !== undefined) record.usage = turn.usage as ExternalTurnRecord['usage']
  if (typeof turn.costUsd === 'number') record.costUsd = turn.costUsd
  if (typeof turn.model === 'string') record.model = turn.model
  return record
}

function isDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}