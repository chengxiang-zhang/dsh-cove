/**
 * Browser HTTP client for the /worktree/* endpoints. Mirrors the host
 * `WorktreeResponse<T>` envelope so success/error paths land on the same
 * type unions as the manager.
 *
 * Every request carries a deadline: a host stalled on `git fetch` (or a dropped
 * network) has to fail visibly instead of leaving the panel loading forever.
 * Failures also keep their kind, because "the fence refused this browser" and
 * "git failed" must not render as the same message — or, worse, as the empty
 * state that means "no registered git repository workspaces".
 * @module dsh-client-ui-worktree/client/api
 */

import type {
  BindLaneInput, BindLaneResult,
  CleanupWorktreeInput, CreateLaneInput, CreateLaneResult, CreateWorktreeInput,
  InitWorktreeInput, LaneLookupInput, LaneView, PrCreateInput, PrCreateResult,
  RemoveWorktreeInput, StatusInput, WorktreeIndex, WorktreeResponse, WorktreeStatusIndex, WorktreeView,
} from '../../../core/worktree/types.ts'
import type { WorktreeErrorCode } from '../../../core/worktree/invariant.ts'

/** Default API prefix — must match `host/routes.ts`. */
const API_PREFIX = '/worktree'

/** Deadline for a read; `status` runs a network `git fetch` on the host. */
const READ_TIMEOUT_MS = 30_000
/** Deadline for a mutation that only touches the local repository. */
const MUTATION_TIMEOUT_MS = 60_000
/** Deadline for a mutation that pushes to the remote. */
const PUSH_TIMEOUT_MS = 180_000

/**
 * How a request failed. `permission` is the host access fence refusing this
 * browser; `domain` is a shaped `ok:false` refusal (git state, busy lane, ...);
 * `transport` is a network/deadline failure; `malformed` is a protocol break.
 */
export type WorktreeApiErrorKind = 'transport' | 'permission' | 'domain' | 'malformed'

/**
 * Thrown by the client when the HTTP layer rejects the request before the
 * envelope. The browser side treats these as transient and surfaces them in
 * the toast/error banner instead of crashing the sidebar.
 */
export class WorktreeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: WorktreeApiErrorKind = 'transport',
    readonly code?: WorktreeErrorCode,
  ) {
    super(message)
    this.name = 'WorktreeApiError'
  }
}

/** AbortSignal.timeout when the runtime has it; jsdom and old engines do not. */
function deadlineSignal(timeoutMs: number): AbortSignal | undefined {
  const factory = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout
  if (typeof factory !== 'function') return undefined
  try {
    return factory.call(AbortSignal, timeoutMs)
  } catch {
    return undefined
  }
}

/** fetch with a deadline; a stalled or aborted request becomes a transport error. */
async function request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    const signal = deadlineSignal(timeoutMs)
    return await fetch(path, signal === undefined ? init : { ...init, signal })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const aborted = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new WorktreeApiError(
      aborted ? `the worktree host did not answer within ${String(timeoutMs)}ms` : message,
      0,
      'transport',
    )
  }
}

/** JSON POST helper shared by every mutation. */
async function postJson(path: string, body: unknown, timeoutMs: number): Promise<Response> {
  return request(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs)
}

/** The refusal text of a non-envelope body (`{ error }` / `{ error: { message } }`). */
function refusalMessageOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as { error?: unknown }).error
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'object' && value !== null) {
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
  }
  return undefined
}

/** The error kind implied by a bare HTTP status. */
function kindForStatus(status: number): WorktreeApiErrorKind {
  return status === 401 || status === 403 ? 'permission' : 'transport'
}

/** A readable message for a status that arrived without the envelope. */
function statusMessage(status: number): string {
  return status === 401 || status === 403
    ? 'this browser is not admitted to the worktree host surface'
    : `worktree endpoint failed with HTTP ${String(status)}`
}

/** Parse a JSON response into the worktree envelope, throwing on transport failure. */
async function envelope<T>(response: Response): Promise<WorktreeResponse<T>> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    if (!response.ok) throw new WorktreeApiError(statusMessage(response.status), response.status, kindForStatus(response.status))
    throw new WorktreeApiError(
      `worktree endpoint returned a non-JSON body (status ${response.status})`,
      response.status,
      'malformed',
    )
  }
  if (
    typeof body !== 'object' || body === null
    || typeof (body as { ok?: unknown }).ok !== 'boolean'
  ) {
    // A fence refusal answers `{ error: ... }` without the envelope: report it
    // as a refusal rather than as a protocol break.
    if (!response.ok) {
      throw new WorktreeApiError(
        refusalMessageOf(body) ?? statusMessage(response.status),
        response.status,
        kindForStatus(response.status),
      )
    }
    throw new WorktreeApiError('worktree endpoint returned a malformed envelope', response.status, 'malformed')
  }
  return body as WorktreeResponse<T>
}

/** The stable domain code of an `ok:false` envelope, when it carries one. */
function codeOf(envelope: WorktreeResponse<unknown>): WorktreeErrorCode | undefined {
  const code = (envelope as { code?: unknown }).code
  return typeof code === 'string' ? code as WorktreeErrorCode : undefined
}

/** Throw a `WorktreeApiError` for any `ok: false` envelope. */
function unwrap<T>(envelope: WorktreeResponse<T>): T {
  if (envelope.ok) return envelope.value
  throw new WorktreeApiError(envelope.message, 0, 'domain', codeOf(envelope))
}

/** The browser-side worktree API surface. */
export class WorktreeApi {
  /**
   * GET /worktree/tree — the registered projects and their lanes.
   * Returns null only for a host half that does not serve the route (404);
   * a refusal, a failure or a broken envelope throws so the panel can say so
   * instead of rendering the "no git repository workspaces" empty state.
   */
  async tree(): Promise<WorktreeIndex | null> {
    const response = await request(`${API_PREFIX}/tree`, { credentials: 'same-origin' }, READ_TIMEOUT_MS)
    if (response.status === 404) return null
    return unwrap(await envelope<WorktreeIndex>(response))
  }

  /** POST /worktree/create */
  async create(input: CreateWorktreeInput): Promise<WorktreeView> {
    return unwrap(await envelope<WorktreeView>(await postJson(`${API_PREFIX}/create`, input, MUTATION_TIMEOUT_MS)))
  }

  /** POST /worktree/remove */
  async remove(input: RemoveWorktreeInput): Promise<{ name: string; path: string }> {
    return unwrap(await envelope<{ name: string; path: string }>(await postJson(`${API_PREFIX}/remove`, input, MUTATION_TIMEOUT_MS)))
  }

  /** POST /worktree/init */
  async init(input: InitWorktreeInput): Promise<{ repoPath: string; initialBranch: string }> {
    return unwrap(await envelope<{ repoPath: string; initialBranch: string }>(await postJson(`${API_PREFIX}/init`, input, MUTATION_TIMEOUT_MS)))
  }

  /** POST /worktree/pr-create — push the branch and obtain a PR page. */
  async prCreate(input: PrCreateInput): Promise<PrCreateResult> {
    return unwrap(await envelope<PrCreateResult>(await postJson(`${API_PREFIX}/pr-create`, input, PUSH_TIMEOUT_MS)))
  }

  /** POST /worktree/status — per-repo PR/merge status. */
  async status(input: StatusInput): Promise<WorktreeStatusIndex> {
    return unwrap(await envelope<WorktreeStatusIndex>(await postJson(`${API_PREFIX}/status`, input, READ_TIMEOUT_MS)))
  }

  /** POST /worktree/cleanup — teardown a merged worktree. */
  async cleanup(input: CleanupWorktreeInput): Promise<{ name: string; path: string }> {
    return unwrap(await envelope<{ name: string; path: string }>(await postJson(`${API_PREFIX}/cleanup`, input, MUTATION_TIMEOUT_MS)))
  }

  /**
   * POST /worktree/lane — resolve the lane a session (or a path) belongs to.
   * Never throws: this feeds the conversation header chip, which must
   * degrade to "no chip" rather than break the header, so a missing route
   * (older host half), a fence refusal, an envelope error and a transport
   * failure all yield `null`.
   */
  async lane(input: LaneLookupInput): Promise<LaneView | null> {
    try {
      const response = await postJson(`${API_PREFIX}/lane`, input, READ_TIMEOUT_MS)
      if (response.status === 404) return null
      const env = await envelope<LaneView | null>(response)
      return env.ok ? env.value : null
    } catch {
      return null
    }
  }

  /** POST /worktree/lane/create — create the lane (worktree + workspace).
   *  The session itself is created by the platform's own create path. */
  async createLane(input: CreateLaneInput): Promise<CreateLaneResult> {
    return unwrap(await envelope<CreateLaneResult>(await postJson(`${API_PREFIX}/lane/create`, input, MUTATION_TIMEOUT_MS)))
  }

  /** POST /worktree/lane/bind — attach the created session to its lane and
   *  apply the lane's permission preset. */
  async bindLane(input: BindLaneInput): Promise<BindLaneResult> {
    return unwrap(await envelope<BindLaneResult>(await postJson(`${API_PREFIX}/lane/bind`, input, MUTATION_TIMEOUT_MS)))
  }

  /** POST /worktree/lane/rollback — undo a lane whose session never came up. */
  async rollbackLane(input: { repoPath: string; branch: string }): Promise<void> {
    unwrap(await envelope<{ branch: string }>(await postJson(`${API_PREFIX}/lane/rollback`, input, MUTATION_TIMEOUT_MS)))
  }
}