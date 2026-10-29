/** HTTP boundary for the stable /git JSON and SSE wire contract. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  isBranchesView, isCommitDiffView, isGitError, isGitMutationResult, isGraphView, isRepoStatus,
  type GitEnvelope, type GitError,
} from '../../../core/git-graph/protocol.ts'
import type { GitService } from './service.ts'
import { accessTrustOf } from '../access-trust/index.ts'
import { registerResources } from '../resources.ts'

const BAD_REQUEST: GitError = { code: 'internal', message: 'malformed request' }
const MALFORMED_VIEW: GitError = { code: 'internal', message: 'malformed git response' }
const STATUS_TIMEOUT_MS = 15_000

/**
 * Whether this request may drive the Git workbench: the shared host access
 * fence (loopback, or a deployment trusted authority with an authenticated
 * browser session), and nothing else. The workbench is served through the
 * deployment's canonical browser entry, so a bare loopback check refused every
 * remote browser behind the documented reverse proxy.
 *
 * A paired-device claim used to be a second allow path here. Nothing in this
 * plugin or in the installed DSH packages provides `remoteWebUiPairing`, so the
 * branch could never admit anything - it only widened the documented rule, the
 * same shape as the `dsh_remote_pair` marker the worktree fence dropped.
 */
function isAllowed(ctx: Context, request: IncomingMessage): boolean {
  return accessTrustOf(ctx).isTrusted(request)
}

async function readBody(request: IncomingMessage): Promise<unknown | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = chunk as Buffer
    size += bytes.length
    if (size > 1024 * 1024) return null
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { return null }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  response.end(JSON.stringify(body))
}

function ok<T>(value: T): GitEnvelope<T> { return { ok: true, value } }
function fail(error: GitError): GitEnvelope<never> { return { ok: false, error } }
function payloadPath(payload: unknown): string | null {
  const path = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).path : undefined
  return typeof path === 'string' && path !== '' ? path : null
}

function checkedView(response: ServerResponse, value: unknown, guard: (value: unknown) => boolean): void {
  writeJson(response, 200, value !== null && !guard(value) ? fail(MALFORMED_VIEW) : ok(value))
}

async function statusWithDeadline(service: GitService, path: string, controller = new AbortController()) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      service.status(path, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('git status timed out')
          controller.abort(error)
          reject(error)
        }, STATUS_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function registerGitRoutes(ctx: Context, service: GitService): () => void {
  const subscribers = new Set<{ path: string; last: string; response: ServerResponse }>()
  let poll: ReturnType<typeof setInterval> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let polling = false

  const stopIfIdle = (): void => {
    if (subscribers.size !== 0) return
    if (poll !== undefined) clearInterval(poll)
    if (heartbeat !== undefined) clearInterval(heartbeat)
    poll = heartbeat = undefined
  }
  const runPoll = async (): Promise<void> => {
    if (polling) return
    polling = true
    try {
      await Promise.all([...subscribers].map(async (subscriber) => {
        try {
          const status = await statusWithDeadline(service, subscriber.path)
          const key = status === null ? 'no-repo' : `${status.root}|${status.branch}|${status.head}`
          if (key === subscriber.last) return
          subscriber.last = key
          subscriber.response.write(`event: change\ndata: ${JSON.stringify({ path: subscriber.path, status })}\n\n`)
        } catch (error) {
          ctx.logger.warn(`dsh-git-graph: status poll failed for ${subscriber.path}: ${String(error)}`)
        }
      }))
    } finally { polling = false }
  }

  const jsonHandler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isAllowed(ctx, request)) return writeJson(response, 403, { error: 'forbidden: loopback-only' })
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
    if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      response.writeHead(415); response.end(); return
    }
    const payload = await readBody(request)
    const path = payloadPath(payload)
    if (path === null) return writeJson(response, 200, fail(BAD_REQUEST))
    const row = payload as Record<string, unknown>
    switch (new URL(request.url ?? '/', 'http://dsh.local').pathname) {
      case '/git/status':
        try { checkedView(response, await statusWithDeadline(service, path), isRepoStatus) }
        catch { writeJson(response, 200, fail({ code: 'internal', message: 'git status timed out' })) }
        return
      case '/git/branches': checkedView(response, await service.branches(path), isBranchesView); return
      case '/git/graph': {
        const limit = typeof row.limit === 'number' && Number.isInteger(row.limit) && row.limit > 0 ? Math.min(row.limit, 200) : undefined
        const cursor = typeof row.cursor === 'string' && /^\d+$/.test(row.cursor) ? row.cursor : undefined
        if (row.cursor !== undefined && cursor === undefined) return writeJson(response, 200, fail(BAD_REQUEST))
        checkedView(response, await service.graph(path, limit, cursor), isGraphView)
        return
      }
      case '/git/commit-diff': {
        if (typeof row.oid !== 'string') return writeJson(response, 200, fail(BAD_REQUEST))
        const value = await service.commitDiff(path, row.oid)
        writeJson(response, 200, isGitError(value) ? fail(value) : isCommitDiffView(value) ? ok(value) : fail(MALFORMED_VIEW))
        return
      }
      case '/git/diff': {
        const file = typeof row.file === 'string' && row.file !== '' ? row.file : undefined
        const value = await service.diff(path, file, row.staged === true)
        writeJson(response, 200, value === null ? fail({ code: 'internal', message: 'git diff failed' }) : ok({ diff: value }))
        return
      }
      case '/git/stage':
      case '/git/unstage': {
        const file = typeof row.file === 'string' && row.file !== '' ? row.file : undefined
        const success = new URL(request.url ?? '/', 'http://dsh.local').pathname === '/git/stage' ? await service.stage(path, file) : await service.unstage(path, file)
        writeJson(response, 200, success ? ok({ changed: true }) : fail({ code: 'internal', message: 'git index update failed' }))
        return
      }
      case '/git/commit': {
        if (typeof row.message !== 'string' || row.message.trim() === '') return writeJson(response, 200, fail(BAD_REQUEST))
        const success = await service.commit(path, row.message)
        writeJson(response, 200, success ? ok({ committed: true }) : fail({ code: 'internal', message: 'git commit failed' }))
        return
      }
      case '/git/switch': {
        if (typeof row.branch !== 'string' || row.branch === '') return writeJson(response, 200, fail(BAD_REQUEST))
        const result = await service.switchBranch(path, row.branch)
        writeJson(response, 200, result.ok ? ok({ branch: result.branch }) : fail(isGitError(result.error) ? result.error : MALFORMED_VIEW))
        return
      }
      case '/git/create-branch': {
        if (typeof row.name !== 'string' || row.name === '') return writeJson(response, 200, fail(BAD_REQUEST))
        const result = await service.createBranch(path, row.name)
        writeJson(response, 200, result.ok ? ok({ branch: result.branch }) : fail(isGitError(result.error) ? result.error : MALFORMED_VIEW))
        return
      }
      case '/git/discard': {
        if (typeof row.file !== 'string') return writeJson(response, 200, fail(BAD_REQUEST))
        const result = await service.discardFile(path, row.file)
        writeJson(response, 200, result.ok && isGitMutationResult(result.value) ? ok(result.value) : !result.ok && isGitError(result.error) ? fail(result.error) : fail(MALFORMED_VIEW))
        return
      }
      case '/git/revert':
      case '/git/cherry-pick': {
        if (typeof row.oid !== 'string') return writeJson(response, 200, fail(BAD_REQUEST))
        const route = new URL(request.url ?? '/', 'http://dsh.local').pathname
        const result = route === '/git/revert' ? await service.revert(path, row.oid) : await service.cherryPick(path, row.oid)
        writeJson(response, 200, result.ok && isGitMutationResult(result.value) ? ok(result.value) : !result.ok && isGitError(result.error) ? fail(result.error) : fail(MALFORMED_VIEW))
        return
      }
      default: response.writeHead(404); response.end()
    }
  }

  const eventsHandler = (request: IncomingMessage, response: ServerResponse): void => {
    if (!isAllowed(ctx, request)) return writeJson(response, 403, { error: 'forbidden: loopback-only' })
    const path = new URL(request.url ?? '/', 'http://dsh.local').searchParams.get('path')
    if (!path) { response.writeHead(400); response.end(); return }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
    response.write('retry: 2000\n\n')
    const subscriber = { path, last: '', response }
    subscribers.add(subscriber)
    const remove = (): void => { subscribers.delete(subscriber); stopIfIdle() }
    request.on('close', remove)
    response.on('error', remove)
    poll ??= setInterval(() => { void runPoll() }, 30_000)
    heartbeat ??= setInterval(() => { for (const current of subscribers) current.response.write(': ping\n\n') }, 15_000)
  }

  return registerResources(own => {
    own(() => {
      if (poll !== undefined) clearInterval(poll)
      if (heartbeat !== undefined) clearInterval(heartbeat)
      for (const subscriber of subscribers) subscriber.response.end()
      subscribers.clear()
    })
    own(ctx.webServer.register({ kind: 'prefix', path: '/git', handler: jsonHandler }))
    own(ctx.webServer.register({ kind: 'exact', path: '/git/events', handler: eventsHandler }))
  })
}
