/**
 * HTTP route layer for the worktree manager. Three responsibilities only:
 *   1. JSON envelope + status code translation
 *   2. Shared host access fence (`accessTrustOf`) for the mutation endpoints
 *   3. Surfacing `WorktreeError` to the browser under the stable
 *      `WorktreeErrorView` contract from `core/types.ts`
 *
 * Route list:
 *   - GET  /worktree/tree          — read; always allowed from the browser
 *   - POST /worktree/lane          — read; resolve the lane a path/session belongs to
 *   - POST /worktree/lane/create   — mutation; shared fence (the branch's worktree)
 *   - POST /worktree/lane/bind     — mutation; shared fence (bind session + preset)
 *   - POST /worktree/lane/rollback — mutation; shared fence (undo a lane with no session)
 *   - POST /worktree/create        — mutation; shared fence
 *   - POST /worktree/remove        — mutation; shared fence
 *   - POST /worktree/init          — mutation; shared fence
 *   - POST /worktree/pr-create     — mutation; shared fence (push + PR)
 *   - POST /worktree/status        — read of remote state but runs git fetch; shared fence
 *   - POST /worktree/cleanup       — mutation; shared fence (merged worktree teardown)
 * @module dsh-client-ui-worktree/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WorktreeError } from '../../../core/worktree/invariant.ts'
import { isInsidePath } from '../../../core/worktree/paths.ts'
import type {
  CleanupWorktreeInput, CreateLaneInput, CreateWorktreeInput, InitWorktreeInput,
  LaneLookupInput, PrCreateInput,
  RemoveWorktreeInput, StatusInput, WorktreeResponse,
} from '../../../core/worktree/types.ts'
import { accessTrustOf } from '../access-trust/index.ts'
import { registerResources, type OwnResource } from '../resources.ts'
import { isLoopbackRequest } from '../access-trust/trust.ts'
import { readJsonObject, writeJson } from './http.ts'
import type { WorktreeManager } from './manager.ts'
import type { SessionLaneManager } from './session-lane/manager.ts'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  ghPrCreateArgv, normalizePrCreateInput, parseGhPrCreateOutput,
  type PrCreateErrorCode, type PrCreateInput as GhPrCreateInput,
} from '../../../core/worktree/pr-create.ts'
import {
  commandFailure, commandFailureText, isCommandTimeout, runCommand,
  type RunCommand,
} from './run-command.ts'

/** Per-route URL prefix (matches dsh-git-graph's /git/* discipline). */
export const API_PREFIX = '/worktree'

/** Structural face over the host workspace registry (its admission list). */
interface WorkspaceListFace { list(): Array<{ path: string }> }

/**
 * Whether a request names a repository outside every workspace the host has
 * registered.
 *
 * These routes carry an explicit repository path, so without this rule a trusted
 * request could aim this domain's mutations at any git repository on the
 * machine. It is the same containment the Git workbench applies through its
 * workspace gate (`realpath` + the registry's own list), and it fails closed: a
 * registry that cannot enumerate admits nothing.
 */
async function outsideRegisteredWorkspaces(ctx: Context, repoPath: string): Promise<boolean> {
  const registry = (ctx as { workspaceRegistry?: WorkspaceListFace }).workspaceRegistry
  if (registry === undefined || typeof registry.list !== 'function') return true
  let canonical = repoPath
  try {
    const { realpath } = await import('node:fs/promises')
    canonical = await realpath(repoPath)
  } catch {
    // A path that does not resolve on disk is compared exactly as given.
  }
  return !registry.list().some((workspace) => isInsidePath(workspace.path, canonical))
}

/** Error body used for non-domain failures (malformed body, etc.). */
const BAD_REQUEST = { ok: false, code: 'git-failed' as const, message: 'malformed request' }
const FORBIDDEN = { ok: false, code: 'git-failed' as const, message: 'mutation endpoints require the host access fence' }

/** Convert a `WorktreeError` (or any thrown value) to a stable error view. */
function errorToView(error: unknown): { status: number; body: WorktreeResponse<never> } {
  if (error instanceof WorktreeError) {
    return { status: 400, body: { ok: false, code: error.code, message: error.message } }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, body: { ok: false, code: 'git-failed', message } }
}

/** Pull a string field from a JSON object, returning `null` when missing. */
function stringField(body: Record<string, unknown> | null, name: string): string | null {
  if (body === null) return null
  const value = body[name]
  return typeof value === 'string' && value !== '' ? value : null
}

/** Pull an optional boolean field (default false). */
function boolField(body: Record<string, unknown> | null, name: string): boolean {
  if (body === null) return false
  return body[name] === true
}

/** Pull an optional string field. */
function optionalString(body: Record<string, unknown> | null, name: string): string | undefined {
  if (body === null) return undefined
  const value = body[name]
  return typeof value === 'string' ? value : undefined
}

/** CORS preflight short-circuit for the mutation routes. */
function handleOptions(res: ServerResponse): void {
  res.writeHead(204, {
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
  })
  res.end()
}

/**
 * True when the request may mutate host worktree state: the shared host access
 * fence (loopback, or a deployment trusted authority with an authenticated
 * browser session). There is exactly one admission rule; a presence-only
 * cookie is never an allow path (the pre-0.4 `dsh_remote_pair` cookie was read
 * but never minted by this plugin, so it only widened the surface).
 */
export interface WorktreeDeps {
  resolveProjectRoot(cwd: string): string | undefined
  runCommand?: RunCommand
  logger: { warn(error: unknown): void }
  /** Host access fence; defaults to the strict loopback rule. */
  isTrusted?(req: IncomingMessage): boolean
}

function classifyGhFailure(error: unknown): { status: number; code: PrCreateErrorCode; message: string } {
  const failure = commandFailure(error)
  const text = commandFailureText(error)
  const normalized = text.toLowerCase()
  if (failure?.code === 'ENOENT') return { status: 503, code: 'gh-not-installed', message: 'GitHub CLI (gh) is not installed or not available on PATH' }
  if (isCommandTimeout(error)) return { status: 504, code: 'timeout', message: 'GitHub CLI timed out while creating the pull request' }
  if (/not logged in|not authenticated|authentication required|gh auth login|http 401|bad credentials/u.test(normalized)) return { status: 401, code: 'gh-not-authenticated', message: 'GitHub CLI is not authenticated; run gh auth login' }
  if (/pull request .*already exists|already exists .*pull request|a pull request already exists/u.test(normalized)) return { status: 409, code: 'pr-already-exists', message: 'A pull request already exists for this head branch' }
  return { status: 502, code: 'gh-failed', message: text.trim() || 'GitHub CLI failed to create the pull request' }
}

/** Compatibility route factory for the richer argv-only gh PR form. */
export function makeWorktreeRoutes(deps: WorktreeDeps): WebRoute[] {
  const canMutate = deps.isTrusted ?? isLoopbackRequest
  return [{
    kind: 'exact', path: `${API_PREFIX}/pr-create`, handler: async (req, res) => {
      if (!canMutate(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
      if (req.method !== 'POST') { writeJson(res, 405, { error: `method not allowed: ${req.method}` }); return }
      let body: Record<string, unknown> | null
      try { body = await readJsonObject(req) } catch { body = null }
      if (body === null) { writeJson(res, 400, { ok: false, code: 'invalid-input', message: 'request body must be a JSON object' }); return }
      const normalized = normalizePrCreateInput(body as GhPrCreateInput)
      if (!normalized.ok) { writeJson(res, 400, { ok: false, code: 'invalid-input', message: normalized.message }); return }
      const root = deps.resolveProjectRoot(normalized.value.cwd)
      if (root === undefined) { writeJson(res, 400, { ok: false, code: 'invalid-input', message: 'cwd must resolve to a project root' }); return }
      const { cwd: _cwd, ...input } = normalized.value
      try {
        const result = await (deps.runCommand ?? runCommand)('gh', ghPrCreateArgv(input), { cwd: root, timeoutMs: 30_000, maxBuffer: 4 * 1024 * 1024 })
        const parsed = parseGhPrCreateOutput(result.stdout)
        if (parsed === undefined) { writeJson(res, 502, { ok: false, code: 'invalid-gh-response', message: 'GitHub CLI did not return a pull request URL' }); return }
        const value = { ...parsed, prUrl: parsed.url, method: 'api' as const }
        writeJson(res, 200, { ok: true, value, ...value })
      } catch (error) {
        const failure = classifyGhFailure(error)
        if (failure.code === 'gh-failed') deps.logger.warn(error)
        writeJson(res, failure.status, { ok: false, code: failure.code, message: failure.message })
      }
    },
  }]
}

/** Register all /worktree/* routes. Returns the dispose function. */
export function registerWorktreeRoutes(
  ctx: Context,
  manager: WorktreeManager,
  lanes?: SessionLaneManager,
  compatibility?: WorktreeDeps,
): () => void {
  return registerResources(own => registerOwnedWorktreeRoutes(ctx, manager, own, lanes, compatibility))
}

/** Acquire each route inside the registration transaction, including compatibility routes. */
function registerOwnedWorktreeRoutes(
  ctx: Context,
  manager: WorktreeManager,
  own: OwnResource<() => void>,
  lanes?: SessionLaneManager,
  compatibility?: WorktreeDeps,
): void {
  const isTrusted = accessTrustOf(ctx).isTrusted
  const canMutate = isTrusted
  if (compatibility !== undefined) {
    for (const route of makeWorktreeRoutes({ ...compatibility, isTrusted })) own(ctx.webServer.register(route))
  }

  // GET /worktree/tree — read of host filesystem state (registered workspace
  // roots, branches, worktree paths), so it carries the shared host access
  // fence like every other privileged host surface. The sidebar renders it only
  // for a browser the deployment admitted; an undeclared Host or a sessionless
  // remote browser must not enumerate the host's repositories.
  own(ctx.webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/tree`,
    handler: async (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, BAD_REQUEST); return }
      if (!isTrusted(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
      try {
        const tree = await manager.getIndex()
        writeJson(res, 200, { ok: true, value: tree } satisfies WorktreeResponse<typeof tree>)
      } catch (error) {
        const { status, body } = errorToView(error)
        writeJson(res, status, body)
      }
    },
  }))

  // POST /worktree/lane — read: resolve the lane a path or session belongs to.
  // Gated by the shared host access fence, exactly like GET /worktree/tree.
  if (lanes !== undefined) {
    own(ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/lane`,
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') { handleOptions(res); return }
        if (req.method !== 'POST') { writeJson(res, 405, BAD_REQUEST); return }
        if (!isTrusted(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        let body: Record<string, unknown> | null
        try { body = await readJsonObject(req) } catch (error) {
          writeJson(res, 400, { ok: false, code: 'git-failed', message: error instanceof Error ? error.message : String(error) })
          return
        }
        const path = optionalString(body, 'path')
        const sessionId = optionalString(body, 'sessionId')
        if ((path === undefined || path === '') && (sessionId === undefined || sessionId === '')) {
          writeJson(res, 400, BAD_REQUEST)
          return
        }
        const input: LaneLookupInput = {
          ...(path === undefined ? {} : { path }),
          ...(sessionId === undefined ? {} : { sessionId }),
        }
        try {
          const lane = await lanes.laneForPath(input)
          writeJson(res, 200, { ok: true, value: lane })
        } catch (error) {
          const { status, body: errBody } = errorToView(error)
          writeJson(res, status, errBody)
        }
      },
    }))

    // POST /worktree/lane/create — mutation: the worktree behind one branch
    // (existing branch attached, missing branch cut). No workspace is
    // registered: a lane binds to a session, not to the workspace list.
    own(ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/lane/create`,
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') { handleOptions(res); return }
        if (req.method !== 'POST') { writeJson(res, 405, BAD_REQUEST); return }
        if (!canMutate(req)) { writeJson(res, 403, FORBIDDEN); return }
        let body: Record<string, unknown> | null
        try { body = await readJsonObject(req) } catch (error) {
          writeJson(res, 400, { ok: false, code: 'git-failed', message: error instanceof Error ? error.message : String(error) })
          return
        }
        const repoPath = stringField(body, 'repoPath')
        const branch = stringField(body, 'branch')
        if (repoPath === null || branch === null) { writeJson(res, 400, BAD_REQUEST); return }
        if (await outsideRegisteredWorkspaces(ctx, repoPath)) {
          writeJson(res, 400, { ok: false, code: 'workspace-unknown', message: 'the repository is outside every registered workspace' })
          return
        }
        const base = optionalString(body, 'base')
        const input: CreateLaneInput = {
          repoPath,
          branch,
          ...(base === undefined ? {} : { base }),
        }
        try {
          const created = await lanes.createLane(input)
          writeJson(res, 200, { ok: true, value: created })
        } catch (error) {
          const { status, body: errBody } = errorToView(error)
          writeJson(res, status, errBody)
        }
      },
    }))

    // POST /worktree/lane/bind — mutation: attach the platform-created
    // session to its lane and apply the lane's permission preset.
    own(ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/lane/bind`,
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') { handleOptions(res); return }
        if (req.method !== 'POST') { writeJson(res, 405, BAD_REQUEST); return }
        if (!canMutate(req)) { writeJson(res, 403, FORBIDDEN); return }
        let body: Record<string, unknown> | null
        try { body = await readJsonObject(req) } catch (error) {
          writeJson(res, 400, { ok: false, code: 'git-failed', message: error instanceof Error ? error.message : String(error) })
          return
        }
        const repoPath = stringField(body, 'repoPath')
        const branch = stringField(body, 'branch')
        const sessionId = stringField(body, 'sessionId')
        if (repoPath === null || branch === null || sessionId === null) {
          writeJson(res, 400, BAD_REQUEST)
          return
        }
        if (await outsideRegisteredWorkspaces(ctx, repoPath)) {
          writeJson(res, 400, { ok: false, code: 'workspace-unknown', message: 'the repository is outside every registered workspace' })
          return
        }
        try {
          const bound = await lanes.bindLaneSession({ repoPath, branch, sessionId })
          writeJson(res, 200, { ok: true, value: bound })
        } catch (error) {
          const { status, body: errBody } = errorToView(error)
          writeJson(res, status, errBody)
        }
      },
    }))

    // POST /worktree/lane/rollback — mutation: undo a lane whose session
    // never came up, so a failed start leaves no stray worktree behind.
    own(ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/lane/rollback`,
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') { handleOptions(res); return }
        if (req.method !== 'POST') { writeJson(res, 405, BAD_REQUEST); return }
        if (!canMutate(req)) { writeJson(res, 403, FORBIDDEN); return }
        let body: Record<string, unknown> | null
        try { body = await readJsonObject(req) } catch (error) {
          writeJson(res, 400, { ok: false, code: 'git-failed', message: error instanceof Error ? error.message : String(error) })
          return
        }
        const repoPath = stringField(body, 'repoPath')
        const branch = stringField(body, 'branch')
        if (repoPath === null || branch === null) { writeJson(res, 400, BAD_REQUEST); return }
        if (await outsideRegisteredWorkspaces(ctx, repoPath)) {
          writeJson(res, 400, { ok: false, code: 'workspace-unknown', message: 'the repository is outside every registered workspace' })
          return
        }
        try {
          await lanes.rollbackLane({ repoPath, branch })
          writeJson(res, 200, { ok: true, value: { branch } })
        } catch (error) {
          const { status, body: errBody } = errorToView(error)
          writeJson(res, status, errBody)
        }
      },
    }))
  }

  // POST /worktree/create
  own(ctx.webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/create`,
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') { handleOptions(res); return }
      if (req.method !== 'POST') { writeJson(res, 405, BAD_REQUEST); return }
      if (!canMutate(req)) { writeJson(res, 403, FORBIDDEN); return }
      let body: Record<string, unknown> | null
      try { body = await readJsonObject(req) } catch (error) {
        writeJson(res, 400, { ok: false, code: 'git-failed', message: error instanceof Error ? error.message : String(error) })
        return
      }
      const repoPath = stringField(body, 'repoPath')
      const branch = stringField(body, 'branch')
      if (repoPath === null || branch === null) { writeJson(res, 400, BAD_REQUEST); return }
      if (await outsideRegisteredWorkspaces(ctx, repoPath)) {
        writeJson(res, 400, { ok: false, code: 'workspace-unknown', message: 'the repository is outside every registered workspace' })
        return
      }
      const input: CreateWorktreeInput = {
        repoPath,
        branch,
        ...(optionalString(body, 'base') !== undefined ? { base: optionalString(body, 'base') as string } : {}),
      }
      try {
        const worktree = await manager.create(input)
        writeJson(res, 200, { ok: true, value: worktree })
      } catch (error) {
        const { status, body: errBody } = errorToView(error)
        writeJson(res, status, errBody)
      }
    },
  }))

  // POST /worktree/remove
  own(ctx.webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/remove`,
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') { handleOptions(res); return }
      if (req.method !== 'POST') { writeJson(res, 405, BAD_REQUEST); return }
      if (!canMutate(req)) { writeJson(res, 403, FORBIDDEN); return }
      let body: Record<string, unknown> | null
      try { body = await readJsonObject(req) } catch (error) {
        writeJson(res, 400, { ok: false, code: 'git-failed', message: error instanceof Error ? error.message : String(error) })
        return
      }
      const repoPath = stringField(body, 'repoPath')
      const name = stringField(body, 'name')
      if (repoPath === null || name === null) { writeJson(res, 400, BAD_REQUEST); return }
      if (await outsideRegisteredWorkspaces(ctx, repoPath)) {
        writeJson(res, 400, { ok: false, code: 'workspace-unknown', message: 'the repository is outside every registered workspace' })
        return
      }
      const sessionId = optionalString(body, 'sessionId')
      const input: RemoveWorktreeInput = {
        repoPath,
        name,
        force: boolField(body, 'force'),
        ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
      }
      try {
        const result = await manager.remove(input)
        writeJson(res, 200, { ok: true, value: result })
      } catch (error) {
        const { status, body: errBody } = errorToView(error)
        writeJson(res, status, errBody)
      }
    },
  }))

  // POST /worktree/init
  own(ctx.webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/init`,
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') { handleOptions(res); return }
      if (req.method !== 'POST') { writeJson(res, 405, BAD_REQUEST); return }
      if (!canMutate(req)) { writeJson(res, 403, FORBIDDEN); return }
      let body: Record<string, unknown> | null
      try { body = await readJsonObject(req) } catch (error) {
        writeJson(res, 400, { ok: false, code: 'git-failed', message: error instanceof Error ? error.message : String(error) })
        return
      }
      const repoPath = stringField(body, 'repoPath')
      if (repoPath === null) { writeJson(res, 400, BAD_REQUEST); return }
      const input: InitWorktreeInput = {
        repoPath,
        ...(optionalString(body, 'initialBranch') !== undefined ? { initialBranch: optionalString(body, 'initialBranch') as string } : {}),
      }
      try {
        const result = await manager.init(input)
        writeJson(res, 200, { ok: true, value: result })
      } catch (error) {
        const { status, body: errBody } = errorToView(error)
        writeJson(res, status, errBody)
      }
    },
  }))

  // POST /worktree/pr-create
  own(ctx.webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/pr-create`,
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') { handleOptions(res); return }
      if (req.method !== 'POST') { writeJson(res, 405, BAD_REQUEST); return }
      if (!canMutate(req)) { writeJson(res, 403, FORBIDDEN); return }
      let body: Record<string, unknown> | null
      try { body = await readJsonObject(req) } catch (error) {
        writeJson(res, 400, { ok: false, code: 'git-failed', message: error instanceof Error ? error.message : String(error) })
        return
      }
      const repoPath = stringField(body, 'repoPath')
      const name = stringField(body, 'name')
      if (repoPath === null || name === null) { writeJson(res, 400, BAD_REQUEST); return }
      if (await outsideRegisteredWorkspaces(ctx, repoPath)) {
        writeJson(res, 400, { ok: false, code: 'workspace-unknown', message: 'the repository is outside every registered workspace' })
        return
      }
      const input: PrCreateInput = {
        repoPath,
        name,
        ...(optionalString(body, 'baseRef') !== undefined ? { baseRef: optionalString(body, 'baseRef') as string } : {}),
        ...(optionalString(body, 'title') !== undefined ? { title: optionalString(body, 'title') as string } : {}),
      }
      try {
        const result = await manager.prCreate(input)
        writeJson(res, 200, { ok: true, value: result })
      } catch (error) {
        const { status, body: errBody } = errorToView(error)
        writeJson(res, status, errBody)
      }
    },
  }))

  // POST /worktree/status
  own(ctx.webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/status`,
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') { handleOptions(res); return }
      if (req.method !== 'POST') { writeJson(res, 405, BAD_REQUEST); return }
      if (!canMutate(req)) { writeJson(res, 403, FORBIDDEN); return }
      let body: Record<string, unknown> | null
      try { body = await readJsonObject(req) } catch (error) {
        writeJson(res, 400, { ok: false, code: 'git-failed', message: error instanceof Error ? error.message : String(error) })
        return
      }
      const repoPath = stringField(body, 'repoPath')
      if (repoPath === null) { writeJson(res, 400, BAD_REQUEST); return }
      if (await outsideRegisteredWorkspaces(ctx, repoPath)) {
        writeJson(res, 400, { ok: false, code: 'workspace-unknown', message: 'the repository is outside every registered workspace' })
        return
      }
      const input: StatusInput = {
        repoPath,
        ...(optionalString(body, 'name') !== undefined ? { name: optionalString(body, 'name') as string } : {}),
        ...(boolField(body, 'force') ? { force: true } : {}),
      }
      try {
        const index = await manager.status(input)
        writeJson(res, 200, { ok: true, value: index })
      } catch (error) {
        const { status, body: errBody } = errorToView(error)
        writeJson(res, status, errBody)
      }
    },
  }))

  // POST /worktree/cleanup
  own(ctx.webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/cleanup`,
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') { handleOptions(res); return }
      if (req.method !== 'POST') { writeJson(res, 405, BAD_REQUEST); return }
      if (!canMutate(req)) { writeJson(res, 403, FORBIDDEN); return }
      let body: Record<string, unknown> | null
      try { body = await readJsonObject(req) } catch (error) {
        writeJson(res, 400, { ok: false, code: 'git-failed', message: error instanceof Error ? error.message : String(error) })
        return
      }
      const repoPath = stringField(body, 'repoPath')
      const name = stringField(body, 'name')
      if (repoPath === null || name === null) { writeJson(res, 400, BAD_REQUEST); return }
      if (await outsideRegisteredWorkspaces(ctx, repoPath)) {
        writeJson(res, 400, { ok: false, code: 'workspace-unknown', message: 'the repository is outside every registered workspace' })
        return
      }
      const sessionId = optionalString(body, 'sessionId')
      const input: CleanupWorktreeInput = {
        repoPath,
        name,
        force: boolField(body, 'force'),
        ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
      }
      try {
        const result = await manager.cleanup(input)
        writeJson(res, 200, { ok: true, value: result })
      } catch (error) {
        const { status, body: errBody } = errorToView(error)
        writeJson(res, status, errBody)
      }
    },
  }))

}
