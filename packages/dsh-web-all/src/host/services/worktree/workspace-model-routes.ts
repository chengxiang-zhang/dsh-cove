/**
 * HTTP route layer for the workspace-model manager. Mirrors the worktree
 * route discipline:
 *   1. JSON envelope + status code translation
 *   2. Shared host access fence (`accessTrustOf`) for every endpoint
 *   3. Surfacing errors under the stable `WorkspaceModelResponse` contract
 *
 * Route list:
 *   - GET  /workspace-model/list   — read; always allowed from the browser
 *   - POST /workspace-model/get     — read one path (body `{ path }`)
 *   - POST /workspace-model/set     — mutation; shared fence
 *   - POST /workspace-model/clear   — mutation; shared fence
 * @module dsh-client-ui-worktree/host/workspace-model-routes
 */

import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {
  SetWorkspaceModelInput, WorkspaceModelResponse, WorkspaceModelPreset, WorkspaceModelView,
} from '../../../core/worktree/workspace-model.ts'
import type { WorkspaceModelManager } from './workspace-model.ts'
import { readJsonObject, writeJson } from './http.ts'
import { accessTrustOf } from '../access-trust/index.ts'
import { registerResources, type OwnResource } from '../resources.ts'

/** Per-route URL prefix. */
export const WORKSPACE_MODEL_PREFIX = '/workspace-model'

const BAD_REQUEST: WorkspaceModelResponse<never> = { ok: false, code: 'bad-request', message: 'malformed request' }
const FORBIDDEN: WorkspaceModelResponse<never> = { ok: false, code: 'forbidden', message: 'mutation endpoints require the host access fence' }
const READ_FORBIDDEN: WorkspaceModelResponse<never> = { ok: false, code: 'forbidden', message: 'reads require the host access fence' }

/** Pull a required string field, or null when absent/empty. */
function stringField(body: Record<string, unknown> | null, name: string): string | null {
  if (body === null) return null
  const value = body[name]
  return typeof value === 'string' && value !== '' ? value : null
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
 * True when the request may mutate: the shared host access fence (loopback, or
 * a deployment trusted authority with an authenticated browser session).
 * `isTrusted` already carries the whole rule, so there is no second allow path.
 */

/** Wrap a handler that already bounds its own errors. */
function respond<T>(res: ServerResponse, value: WorkspaceModelResponse<T>): void {
  writeJson(res, value.ok ? 200 : value.code === 'forbidden' ? 403 : 400, value)
}

/** Register all /workspace-model/* routes. Returns the dispose function. */
export function registerWorkspaceModelRoutes(ctx: Context, manager: WorkspaceModelManager): () => void {
  return registerResources(own => registerOwnedWorkspaceModelRoutes(ctx, manager, own))
}

function registerOwnedWorkspaceModelRoutes(ctx: Context, manager: WorkspaceModelManager, own: OwnResource<() => void>): void {
  const isTrusted = accessTrustOf(ctx).isTrusted
  const canMutate = isTrusted

  // GET /workspace-model/list
  own(ctx.webServer.register({
    kind: 'exact',
    path: `${WORKSPACE_MODEL_PREFIX}/list`,
    handler: async (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, BAD_REQUEST); return }
      if (!isTrusted(req)) { respond<never>(res, READ_FORBIDDEN); return }
      const list = manager.list()
      const views: WorkspaceModelView[] = Object.entries(list).map(([path, preset]) => ({ path, preset }))
      writeJson(res, 200, { ok: true, value: views })
    },
  }))

  // POST /workspace-model/get
  own(ctx.webServer.register({
    kind: 'exact',
    path: `${WORKSPACE_MODEL_PREFIX}/get`,
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') { handleOptions(res); return }
      if (req.method !== 'POST') { writeJson(res, 405, BAD_REQUEST); return }
      if (!isTrusted(req)) { respond<never>(res, READ_FORBIDDEN); return }
      let body: Record<string, unknown> | null
      try { body = await readJsonObject(req) } catch { writeJson(res, 400, BAD_REQUEST); return }
      const path = stringField(body, 'path')
      if (path === null) { writeJson(res, 400, BAD_REQUEST); return }
      respond<WorkspaceModelView>(res, { ok: true, value: { path, preset: manager.get(path) } })
    },
  }))

  // POST /workspace-model/set
  own(ctx.webServer.register({
    kind: 'exact',
    path: `${WORKSPACE_MODEL_PREFIX}/set`,
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') { handleOptions(res); return }
      if (req.method !== 'POST') { writeJson(res, 405, BAD_REQUEST); return }
      if (!canMutate(req)) { writeJson(res, 403, FORBIDDEN); return }
      let body: Record<string, unknown> | null
      try { body = await readJsonObject(req) } catch { writeJson(res, 400, BAD_REQUEST); return }
      const path = stringField(body, 'path')
      const preset = body?.preset
      if (path === null || typeof preset !== 'object' || preset === null || Array.isArray(preset)) {
        writeJson(res, 400, BAD_REQUEST); return
      }
      const p = preset as Partial<WorkspaceModelPreset>
      if (typeof p.provider !== 'string' || p.provider === '' || typeof p.model !== 'string' || p.model === '') {
        writeJson(res, 400, BAD_REQUEST); return
      }
      if (p.reasoningEffort !== undefined && typeof p.reasoningEffort !== 'string') {
        writeJson(res, 400, BAD_REQUEST); return
      }
      const input: SetWorkspaceModelInput = {
        path,
        preset: { provider: p.provider, model: p.model, ...(p.reasoningEffort !== undefined ? { reasoningEffort: p.reasoningEffort } : {}) },
      }
      try {
        const stored = await manager.set(input.path, input.preset)
        respond<WorkspaceModelPreset>(res, { ok: true, value: stored })
      } catch (error) {
        writeJson(res, 500, { ok: false, code: 'bad-request', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  // POST /workspace-model/clear
  own(ctx.webServer.register({
    kind: 'exact',
    path: `${WORKSPACE_MODEL_PREFIX}/clear`,
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') { handleOptions(res); return }
      if (req.method !== 'POST') { writeJson(res, 405, BAD_REQUEST); return }
      if (!canMutate(req)) { writeJson(res, 403, FORBIDDEN); return }
      let body: Record<string, unknown> | null
      try { body = await readJsonObject(req) } catch { writeJson(res, 400, BAD_REQUEST); return }
      const path = stringField(body, 'path')
      if (path === null) { writeJson(res, 400, BAD_REQUEST); return }
      try {
        const removed = await manager.clear(path)
        respond<boolean>(res, { ok: true, value: removed })
      } catch (error) {
        writeJson(res, 500, { ok: false, code: 'bad-request', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

}
