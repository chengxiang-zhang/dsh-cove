/**
 * ssh host 服务域 —— 路由层（老契约还原）。
 *
 * /api/dsh-ssh 路由族与老 dsh-ssh 插件逐点对齐：hosts CRUD（GET ?query= /
 * POST / PATCH ?alias= / DELETE ?alias=）、import-ssh-config、test、exec、
 * cluster、ls（GET ?alias&path）、tunnel（POST {action: list|start|stop|
 * stop-all}）、upload（NDJSON 进度流）、download（GET 二进制流）。信任围栏为
 * 共享的宿主访问围栏（loopback，或部署声明的 trusted authority + 已登录会话）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { SSH_API, isHostKeyFingerprint, type HostPayload, type ImportResult, type TestResult } from '../../../core/ssh/protocol.ts'
import type { SshEngine } from './engine.ts'
import type { HostStore } from './store.ts'
import { accessTrustOf } from '../access-trust/index.ts'
import { isLoopbackRequest } from '../access-trust/trust.ts'
import { registerResources } from '../resources.ts'

/** 上传体上限（staging 到磁盘后再 SFTP 送出）。 */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024

interface SshRoutesDeps {
  store: HostStore
  engine: SshEngine
  logger: { warn(error: unknown): void }
  /** Host access fence; defaults to the strict loopback rule. */
  isTrusted?(req: IncomingMessage): boolean
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) return null
    chunks.push(buf)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

function makeGuard(isTrusted: (req: IncomingMessage) => boolean) {
  return (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isTrusted(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }
}

function friendlyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** 构建全部 /api/dsh-ssh 路由（老契约）。 */
export function makeRoutes(deps: SshRoutesDeps): WebRoute[] {
  const { store, engine, logger } = deps
  const isTrusted = deps.isTrusted ?? isLoopbackRequest
  const guard = makeGuard(isTrusted)

  return [
    {
      kind: 'exact',
      path: SSH_API.hosts,
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            if (!guard(req, res, 'GET')) return
            const query = queryParam(new URL(req.url ?? '/', 'http://x'), 'query')
            const entries = query !== undefined && query !== '' ? engine.list(query) : engine.list()
            writeJson(res, 200, { hosts: entries })
            return
          }
          if (req.method === 'POST') {
            if (!guard(req, res, 'POST')) return
            const body = await readJsonBody(req, 256 * 1024)
            if (body === null || typeof body !== 'object') {
              writeJson(res, 400, { error: 'invalid JSON body' })
              return
            }
            try {
              const result = store.upsert(body as Parameters<HostStore['upsert']>[0])
              writeJson(res, result.created ? 201 : 200, { host: store.summarize(result.entry) })
            } catch (error) {
              writeJson(res, 400, { error: friendlyError(error) })
            }
            return
          }
          if (req.method === 'PATCH') {
            if (!guard(req, res, 'PATCH')) return
            const alias = queryParam(new URL(req.url ?? '/', 'http://x'), 'alias')
            if (alias === undefined || alias === '') {
              writeJson(res, 400, { error: 'alias query param is required' })
              return
            }
            const body = await readJsonBody(req, 256 * 1024)
            const existing = store.find(alias)
            if (existing === undefined) {
              writeJson(res, 404, { error: `host not found: ${alias}` })
              return
            }
            const patch = (body ?? {}) as Record<string, unknown>
            if (Object.hasOwn(patch, 'hostKeyFingerprint') && patch.hostKeyFingerprint !== null && !isHostKeyFingerprint(patch.hostKeyFingerprint)) {
              writeJson(res, 400, { error: 'hostKeyFingerprint must be a canonical SHA256 fingerprint or null to use known_hosts' })
              return
            }
            const next = store.upsert({
              alias,
              host: typeof patch.host === 'string' && patch.host !== '' ? patch.host : existing.host,
              hostKeyFingerprint: Object.hasOwn(patch, 'hostKeyFingerprint')
                ? (typeof patch.hostKeyFingerprint === 'string' ? patch.hostKeyFingerprint : undefined)
                : existing.hostKeyFingerprint,
              port: typeof patch.port === 'number' ? patch.port : existing.port,
              user: typeof patch.user === 'string' && patch.user !== '' ? patch.user : existing.user,
              auth: (patch as unknown as HostPayload).auth ?? existing.auth,
              proxyJump: Array.isArray(patch.proxyJump) ? patch.proxyJump as string[] : existing.proxyJump,
              description: typeof patch.description === 'string' ? patch.description : existing.description,
              environment: typeof patch.environment === 'string' ? patch.environment : existing.environment,
              tags: Array.isArray(patch.tags) ? patch.tags as string[] : existing.tags,
              location: typeof patch.location === 'string' ? patch.location : existing.location,
            })
            writeJson(res, 200, { host: store.summarize(next.entry) })
            return
          }
          if (req.method === 'DELETE') {
            if (!guard(req, res, 'DELETE')) return
            const aliasDelete = queryParam(new URL(req.url ?? '/', 'http://x'), 'alias')
            if (aliasDelete === undefined || aliasDelete === '') {
              writeJson(res, 400, { error: 'alias query param is required' })
              return
            }
            writeJson(res, 200, { ok: store.remove(aliasDelete) })
            return
          }
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: friendlyError(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.importSshConfig,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const result = store.importSshConfig()
          const parsed = result.imported.length + result.skipped.length
          const summary: ImportResult = {
            parsed,
            added: result.imported.length,
            skipped: result.skipped.length,
            skippedNames: result.skipped,
          }
          writeJson(res, 200, { result: summary })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: friendlyError(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.test,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, 64 * 1024)
          const alias = (body as { alias?: unknown } | null)?.alias
          if (typeof alias !== 'string' || alias === '') {
            writeJson(res, 400, { error: 'alias is required' })
            return
          }
          const startedAt = Date.now()
          const result = await engine.exec(alias, 'echo ok', 10_000)
          const outcome: TestResult = {
            ok: result.success,
            latencyMs: Date.now() - startedAt,
            error: result.error,
          }
          writeJson(res, 200, { result: outcome })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: friendlyError(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.exec,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, 128 * 1024)
          const { alias, command, timeoutMs } = (body ?? {}) as { alias?: unknown; command?: unknown; timeoutMs?: unknown }
          if (typeof alias !== 'string' || alias === '' || typeof command !== 'string' || command === '') {
            writeJson(res, 400, { error: 'alias and command are required' })
            return
          }
          const result = await engine.exec(alias, command, typeof timeoutMs === 'number' ? timeoutMs : undefined)
          writeJson(res, 200, { result })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: friendlyError(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.cluster,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, 128 * 1024)
          const options = (body ?? {}) as { command?: unknown; aliases?: unknown; environment?: unknown; tags?: unknown; timeoutMs?: unknown; maxWorkers?: unknown }
          if (typeof options.command !== 'string' || options.command === '') {
            writeJson(res, 400, { error: 'command is required' })
            return
          }
          const results = await engine.cluster({
            command: options.command,
            aliases: Array.isArray(options.aliases) ? (options.aliases as string[]) : undefined,
            environment: typeof options.environment === 'string' ? options.environment : undefined,
            tags: Array.isArray(options.tags) ? (options.tags as string[]) : undefined,
            timeoutMs: typeof options.timeoutMs === 'number' ? options.timeoutMs : undefined,
            maxWorkers: typeof options.maxWorkers === 'number' ? options.maxWorkers : undefined,
          })
          writeJson(res, 200, { results })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: friendlyError(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.ls,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const alias = queryParam(url, 'alias')
          const path = queryParam(url, 'path')
          if (alias === undefined || path === undefined) {
            writeJson(res, 400, { error: 'alias and path query parameters are required' })
            return
          }
          const entries = await engine.ls(alias, path)
          writeJson(res, 200, { entries })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: friendlyError(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.tunnel,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req, 64 * 1024)
          const { action } = (body ?? {}) as { action?: unknown }
          if (action === 'list') {
            writeJson(res, 200, { tunnels: engine.listTunnels() })
            return
          }
          if (action === 'start') {
            const { alias, remotePort, remoteHost, localPort } = (body ?? {}) as { alias?: unknown; remotePort?: unknown; remoteHost?: unknown; localPort?: unknown }
            if (typeof alias !== 'string' || typeof remotePort !== 'number') {
              writeJson(res, 400, { error: 'alias and remotePort are required' })
              return
            }
            const tunnel = await engine.tunnel(alias, typeof localPort === 'number' ? localPort : 0, typeof remoteHost === 'string' ? remoteHost : '127.0.0.1', remotePort)
            writeJson(res, 200, { tunnel })
            return
          }
          if (action === 'stop') {
            const { tunnelId } = (body ?? {}) as { tunnelId?: unknown }
            if (typeof tunnelId !== 'string' || tunnelId === '') {
              writeJson(res, 400, { error: 'tunnelId is required' })
              return
            }
            writeJson(res, 200, { ok: engine.stopTunnel(tunnelId) })
            return
          }
          if (action === 'stop-all') {
            const { alias } = (body ?? {}) as { alias?: unknown }
            const stopped = engine.stopAllTunnels(typeof alias === 'string' ? alias : undefined)
            writeJson(res, 200, { stopped })
            return
          }
          writeJson(res, 400, { error: 'unknown tunnel action' })
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: friendlyError(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.upload,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const url = new URL(req.url ?? '/', 'http://x')
        const alias = queryParam(url, 'alias')
        const remotePath = queryParam(url, 'remotePath')
        if (alias === undefined || remotePath === undefined) {
          writeJson(res, 400, { error: 'alias and remotePath query parameters are required' })
          return
        }
        const declared = Number(req.headers['content-length'])
        if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
          writeJson(res, 413, { error: 'upload body too large' })
          return
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' })
        const emit = (line: unknown): void => { try { res.write(JSON.stringify(line) + '\n') } catch { /* client gone */ } }
        const staging = join(tmpdir(), 'dsh-ssh-uploads')
        mkdirSync(staging, { recursive: true })
        const tmp = join(staging, `upload-${randomBytes(6).toString('hex')}`)
        const sink = createWriteStream(tmp, { mode: 0o600 })
        let settled = false
        const cleanup = (): void => { void unlink(tmp).catch(() => undefined).finally(() => { try { res.end() } catch { /* closed */ } }) }
        const fail = (error: unknown): void => {
          if (settled) return
          settled = true
          emit({ type: 'result', ok: false, error: error instanceof Error ? error.message : String(error) })
          if (sink.destroyed) cleanup()
          else { sink.once('close', cleanup); try { sink.destroy() } catch { cleanup() } }
        }
        const done = (): void => { if (!settled) { settled = true; try { res.end() } catch { /* closed */ } } }
        sink.on('error', fail)
        req.on('error', fail)
        req.on('aborted', () => fail('upload aborted by the client'))
        res.on('error', () => fail('response stream closed'))
        res.on('close', () => { if (!res.writableEnded) fail('connection closed') })
        let received = 0
        let capped = false
        req.on('data', (chunk: Buffer) => {
          received += chunk.byteLength
          if (received > MAX_UPLOAD_BYTES && !capped) {
            capped = true
            fail('upload body too large')
            res.on('finish', () => { try { req.destroy() } catch { /* closed */ } })
            return
          }
          sink.write(chunk)
        })
        req.on('end', () => {
          sink.end(() => {
            if (settled) return
            void engine.upload(alias, tmp, remotePath, progress => emit({ type: 'progress', progress }))
              .then(result => { emit({ type: 'result', ok: true, transferredBytes: result.bytes }); done() })
              .catch(error => fail(error))
          })
        })
      },
    },
    {
      kind: 'exact',
      path: SSH_API.download,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const alias = queryParam(url, 'alias')
          const remotePath = queryParam(url, 'remotePath')
          if (alias === undefined || remotePath === undefined) {
            writeJson(res, 400, { error: 'alias and remotePath query parameters are required' })
            return
          }
          const staging = join(tmpdir(), 'dsh-ssh-downloads')
          mkdirSync(staging, { recursive: true })
          const local = join(staging, `download-${randomBytes(6).toString('hex')}`)
          const result = await engine.download(alias, remotePath, local)
          const filename = remotePath.split('/').pop() ?? 'download'
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(result.bytes),
            'cache-control': 'no-cache',
            'content-disposition': `attachment; filename="${filename}"`,
          })
          const stream = createReadStream(local)
          stream.on('error', () => { try { res.destroy() } catch { /* closed */ } })
          stream.on('close', () => { void unlink(local).catch(() => undefined) })
          stream.pipe(res)
        } catch (error) {
          logger.warn(error)
          writeJson(res, 500, { error: friendlyError(error) })
        }
      },
    },
    {
      kind: 'prefix',
      path: SSH_API.terminal,
      handler: async (req, res) => {
        // 特权面即使在“什么也不做”的分支上也要先过围栏：未受信调用方拿到 426
        // 就等于确认了这条路径存在。真正的交互 shell 由 terminal-ws 的 upgrade 提供。
        if (!isTrusted(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        writeJson(res, 426, { error: 'terminal requires websocket upgrade' })
      },
    },
  ]
}

/** 服务域注册入口。 */
export function registerRoutes(ctx: Context, deps: SshRoutesDeps): () => void {
  const routes = makeRoutes({ ...deps, isTrusted: accessTrustOf(ctx).isTrusted })
  return registerResources(own => {
    for (const route of routes) own(ctx.webServer.register(route))
  })
}
