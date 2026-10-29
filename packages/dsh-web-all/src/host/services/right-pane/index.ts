/** Register the web-all right-pane host routes: sandboxed-browser probing and workspace Git status. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, relative, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { BetterSidebarError } from './wire.ts'
import { probeBrowserUrl } from './browser.ts'
import { accessTrustOf } from '../access-trust/index.ts'
import { isLoopbackRequest } from '../access-trust/trust.ts'

const execFileAsync = promisify(execFile)

interface RegisteredWorkspace {
  id: string
  path: string
  sessionIds: readonly string[]
}

export interface WorkbenchScopeRegistry {
  list(): Array<{ id: unknown; path: string; sessionIds: readonly unknown[] }>
}

/** The strict loopback core of the workbench fence (kept for direct callers). */
export function trusted(request: IncomingMessage): boolean {
  return isLoopbackRequest(request)
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(value))
}

async function jsonBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) throw new BetterSidebarError('too-large', `request body exceeds ${maxBytes} bytes`)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > maxBytes) throw new BetterSidebarError('too-large', `request body exceeds ${maxBytes} bytes`)
    chunks.push(value)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }
  catch { throw new BetterSidebarError('bad-request', 'request body must be valid JSON') }
}

function inside(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

/** Resolve a root token and optional session membership against the host registry. */
export function resolveRegisteredWorkspace(registry: WorkbenchScopeRegistry, rootToken: string, sessionId?: string): RegisteredWorkspace {
  const match = registry.list().find(workspace => String(workspace.id) === rootToken || workspace.path === rootToken)
  if (!match) throw new BetterSidebarError('forbidden', 'workspace root is not registered')
  const sessionIds = match.sessionIds.map(String)
  if (sessionId !== undefined && sessionId !== '' && !sessionIds.includes(sessionId)) {
    throw new BetterSidebarError('forbidden', 'session does not belong to this workspace')
  }
  return { id: String(match.id), path: match.path, sessionIds }
}

function targetFromQuery(registry: WorkbenchScopeRegistry, url: URL): { root: RegisteredWorkspace; path: string } {
  const sessionId = url.searchParams.get('session') ?? undefined
  let rootToken = url.searchParams.get('root') ?? ''
  let path = url.searchParams.get('path') ?? ''
  // An absolute path is accepted only after it is mapped beneath a registered
  // workspace. It never reaches the filesystem directly.
  if (rootToken === '' && isAbsolute(path)) {
    const workspace = registry.list().find(candidate => inside(candidate.path, path))
    if (!workspace) throw new BetterSidebarError('forbidden', 'absolute path is outside registered workspaces')
    rootToken = String(workspace.id)
    path = relative(workspace.path, path).split(sep).join('/')
  }
  if (rootToken === '') throw new BetterSidebarError('bad-request', 'workspace root is required')
  return { root: resolveRegisteredWorkspace(registry, rootToken, sessionId), path }
}

export function register(ctx: Context): () => void {
  const registry = ctx.workspaceRegistry as unknown as WorkbenchScopeRegistry
  const isTrusted = accessTrustOf(ctx).isTrusted
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isTrusted(request)) return json(response, 403, { error: 'forbidden' })
    const url = new URL(request.url ?? '/', 'http://dsh.local')
    try {
      if (url.pathname === '/api/workbench/browser-probe' && request.method === 'POST') {
        const payload = await jsonBody(request)
        if (typeof payload.url !== 'string') throw new BetterSidebarError('bad-request', 'url is required')
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000)
        try { return json(response, 200, await probeBrowserUrl(payload.url, fetch, controller.signal)) } finally { clearTimeout(timer) }
      }
      if (url.pathname === '/api/workbench/git-status' && request.method === 'GET') {
        const target = targetFromQuery(registry, url)
        if (target.path !== '') throw new BetterSidebarError('bad-request', 'git status root must be the workspace root')
        const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-z'], { cwd: target.root.path, timeout: 10_000, maxBuffer: 1024 * 1024 })
        const entries = stdout.split('\0').filter(Boolean).map(row => ({ xy: row.slice(0, 2), path: row.slice(3) }))
        return json(response, 200, { entries })
      }
      response.writeHead(404); response.end()
    } catch (error) {
      const code = error instanceof BetterSidebarError ? error.code : 'internal'
      const status = code === 'bad-request' ? 400
        : code === 'forbidden' ? 403
          : code === 'not-found' ? 404
            : code === 'too-large' ? 413
              : 500
      json(response, status, { error: error instanceof Error ? error.message : String(error), code })
    }
  }
  const disposeHttp = ctx.webServer.register({ kind: 'prefix', path: '/api/workbench', handler })
  return () => { disposeHttp() }
}

export { BetterSidebarError } from './wire.ts'