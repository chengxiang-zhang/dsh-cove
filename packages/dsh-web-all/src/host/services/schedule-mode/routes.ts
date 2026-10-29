/**
 * schedule-mode host 路由族：`/api/schedule-mode/*`（JSON envelope `{ok,value}`）。
 *
 *   GET  /tasks    逻辑任务合并视图（原生任务 + 会话模式策略）
 *   POST /mode     切换 `original` / `new`
 *   POST /delete   删除逻辑任务（`new` 模式一并撤下轮转副本）
 *   POST /refresh  与原生目录对齐（幂等收敛）后再返回视图
 *
 * 信任围栏为共享的宿主访问围栏（loopback，或部署声明的 trusted authority +
 * 已登录浏览器会话），与其它家族面板一致。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SCHEDULE_MODE_API_PREFIX } from '../../../core/schedule-mode/view.ts'
import { ScheduleModeError, type ScheduleModeEngine } from './engine.ts'
import { accessTrustOf } from '../access-trust/index.ts'
import { isLoopbackRequest } from '../access-trust/trust.ts'
import { registerResources } from '../resources.ts'

export { SCHEDULE_MODE_API_PREFIX }

/** 路由依赖。 */
export interface ScheduleModeRoutesDeps {
  engine: ScheduleModeEngine
  logger: { warn(error: unknown): void }
  /** Host access fence; defaults to the strict loopback rule. */
  isTrusted?(req: IncomingMessage): boolean
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}

function ok(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { ok: false, error: { code, message } })
}

async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) return null
    chunks.push(buf)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** 组装路由（可直接单测，无需 webServer 服务）。 */
export function makeScheduleModeRoutes(deps: ScheduleModeRoutesDeps): WebRoute[] {
  const { engine, logger } = deps
  const isTrusted = deps.isTrusted ?? isLoopbackRequest
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isTrusted(req)) { fail(res, 403, 'forbidden', 'loopback only'); return }
    const url = new URL(req.url ?? '/', 'http://dsh.local')
    const pathname = url.pathname
    const sessionFilter = url.searchParams.get('sessionId')
    /** 读取一律限定在调用方自己的会话上：不带 sessionId 的整机列举就是跨会话读取。 */
    const scopedSession = (): string | undefined => (sessionFilter === null || sessionFilter === '' ? undefined : sessionFilter)
    const filtered = async (value: Awaited<ReturnType<typeof engine.list>>): Promise<Awaited<ReturnType<typeof engine.list>>> => {
      const scope = scopedSession()
      if (scope === undefined) return { available: value.available, tasks: [] }
      // 过滤值既可以是原会话，也可以是当前运行会话（原生页里轮转副本挂在运行会话上）。
      return { available: value.available, tasks: value.tasks.filter(task => task.sessionId === scope || task.runSessionId === scope) }
    }
    try {
      if (pathname === `${SCHEDULE_MODE_API_PREFIX}/tasks` && req.method === 'GET') {
        ok(res, await filtered(await engine.list()))
        return
      }
      if (pathname === `${SCHEDULE_MODE_API_PREFIX}/refresh` && req.method === 'POST') {
        await engine.reconcile()
        ok(res, await filtered(await engine.list()))
        return
      }
      if (pathname === `${SCHEDULE_MODE_API_PREFIX}/mode` && req.method === 'POST') {
        const body = await readJsonBody(req)
        const sessionId = body?.['sessionId']
        const id = body?.['id']
        const mode = body?.['mode']
        if (typeof sessionId !== 'string' || typeof id !== 'string' || (mode !== 'original' && mode !== 'new')) {
          fail(res, 400, 'bad-request', 'expected { sessionId, id, mode: "original" | "new" }')
          return
        }
        ok(res, { task: await engine.setMode(sessionId, id, mode) })
        return
      }
      if (pathname === `${SCHEDULE_MODE_API_PREFIX}/delete` && req.method === 'POST') {
        const body = await readJsonBody(req)
        const sessionId = body?.['sessionId']
        const id = body?.['id']
        if (typeof sessionId !== 'string' || typeof id !== 'string') {
          fail(res, 400, 'bad-request', 'expected { sessionId, id }')
          return
        }
        ok(res, { deleted: await engine.deleteTask(sessionId, id) })
        return
      }
      fail(res, 404, 'not-found', `unknown route: ${req.method} ${pathname}`)
    } catch (error) {
      if (error instanceof ScheduleModeError) {
        const status = error.code === 'unknown-task' ? 404 : (error.code === 'task-ended' || error.code === 'recovery-required') ? 409 : 400
        fail(res, status, error.code, error.message)
        return
      }
      logger.warn(error)
      fail(res, 500, 'internal', error instanceof Error ? error.message : String(error))
    }
  }
  return [{ kind: 'prefix', path: SCHEDULE_MODE_API_PREFIX, handler }]
}

/** 服务域注册入口（路由）。 */
export function registerScheduleModeRoutes(ctx: Context, deps: ScheduleModeRoutesDeps): () => void {
  return registerResources(own => {
    for (const route of makeScheduleModeRoutes({ ...deps, isTrusted: accessTrustOf(ctx).isTrusted })) own(ctx.webServer.register(route))
  })
}
