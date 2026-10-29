/**
 * schedule-mode 路由契约单测：envelope、状态码映射、loopback 围栏与刷新收敛。
 */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SCHEDULE_MODE_API_PREFIX, makeScheduleModeRoutes, type ScheduleModeRoutesDeps } from '../src/host/services/schedule-mode/routes.ts'
import { ScheduleModeEngine, ScheduleModeError } from '../src/host/services/schedule-mode/engine.ts'
import { ScheduleModeStore } from '../src/host/services/schedule-mode/store.ts'
import type { NativeTaskView } from '../src/core/schedule-mode/native.ts'
import type { NativeCreateRequest } from '../src/core/schedule-mode/types.ts'

/** 临时 store 路径；目录在文件级 afterAll 里统一删除。 */
const tempDirs: string[] = []
function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-schedule-mode-routes-'))
  tempDirs.push(dir)
  return join(dir, 'store.json')
}
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

function makeReq(method: string, url: string, body?: unknown, remoteAddress = '127.0.0.1'): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  Object.assign(req, {
    method,
    url,
    socket: { remoteAddress },
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    },
  })
  return req
}

async function run(deps: ScheduleModeRoutesDeps, method: string, pathname: string, body?: unknown, remoteAddress?: string): Promise<{ status: number; body: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } }> {
  const req = makeReq(method, pathname, body, remoteAddress)
  let status = 0
  let text = ''
  const res = new EventEmitter() as unknown as ServerResponse & { writeHead(code: number): unknown; end(chunk?: string | Buffer): unknown; write(chunk: string | Buffer): boolean; writableEnded: boolean }
  Object.assign(res, {
    writeHead(code: number) { status = code; return this },
    end(chunk?: string | Buffer) { if (chunk !== undefined) text += chunk.toString(); res.emit('finish'); return this },
    write(chunk: string | Buffer) { text += chunk.toString(); return true },
    writableEnded: false,
  })
  const route = makeScheduleModeRoutes(deps).find(candidate => pathname.startsWith(candidate.path))
  if (route === undefined) throw new Error(`no route for ${pathname}`)
  await (route as { handler(req: IncomingMessage, res: ServerResponse): Promise<void> }).handler(req, res as ServerResponse)
  return { status, body: JSON.parse(text) as { ok?: boolean; value?: unknown; error?: { code?: string } } }
}

interface Harness {
  deps: ScheduleModeRoutesDeps
  rows: NativeTaskView[]
  createdSessions: string[]
}

function harness(): Harness {
  const rows: NativeTaskView[] = [{
    sessionId: 'source', id: 'task-1', status: 'active', title: 'Weekly digest', prompt: 'digest the week',
    scheduledAt: '2026-10-10T01:00:00.000Z', rule: { kind: 'daily', time: '09:00:00.000', timeZone: 'UTC' },
  }]
  const createdSessions: string[] = []
  const store = new ScheduleModeStore(tempStorePath())
  const engine = new ScheduleModeEngine(store, {
    listTasks: async () => rows.map(row => ({ ...row })),
    createTask: async (sessionId: string, request: NativeCreateRequest) => {
      const id = `armed-${rows.length + 1}`
      rows.push({
        sessionId, id, status: 'active', title: request.title, prompt: request.prompt,
        scheduledAt: '2026-10-10T01:00:00.000Z', rule: { kind: 'daily', time: '09:00:00.000', timeZone: 'UTC' },
      })
      return { id, scheduledAt: '2026-10-10T01:00:00.000Z' }
    },
    deleteTask: async (sessionId: string, id: string) => {
      const index = rows.findIndex(row => row.id === id && row.sessionId === sessionId)
      if (index >= 0) rows.splice(index, 1)
    },
    inspectSession: async () => ({ cwd: '/repo' }),
    createSession: async () => { createdSessions.push(`run-${createdSessions.length + 1}`); return createdSessions[createdSessions.length - 1] as string },
    now: () => Date.parse('2026-10-09T00:00:00.000Z'),
    log: () => {},
  })
  return { deps: { engine, logger: { warn: () => {} } }, rows, createdSessions }
}

describe('schedule-mode routes', () => {
  it('GET /tasks returns the envelope with the merged task list for the named session', async () => {
    const { deps } = harness()
    const { status, body } = await run(deps, 'GET', `${SCHEDULE_MODE_API_PREFIX}/tasks?sessionId=source`)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const value = body.value as { available: boolean; tasks: Array<{ id: string; mode: string }> }
    expect(value.available).toBe(true)
    expect(value.tasks[0]?.id).toBe('task-1')
    expect(value.tasks[0]?.mode).toBe('original')
  })

  it('never enumerates every session when no sessionId is given', async () => {
    // 不带 sessionId 的整机列举会把每个会话的标题与 prompt 交给任意通过围栏的调用方。
    const { deps } = harness()
    const { status, body } = await run(deps, 'GET', `${SCHEDULE_MODE_API_PREFIX}/tasks`)
    expect(status).toBe(200)
    expect((body.value as { available: boolean; tasks: unknown[] }).tasks).toEqual([])
    const other = await run(deps, 'GET', `${SCHEDULE_MODE_API_PREFIX}/tasks?sessionId=someone-else`)
    expect((other.body.value as { tasks: unknown[] }).tasks).toEqual([])
  })

  it('POST /mode switches to a new session per run and reports the new view', async () => {
    const { deps, rows, createdSessions } = harness()
    const { status, body } = await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/mode`, { sessionId: 'source', id: 'task-1', mode: 'new' })
    expect(status).toBe(200)
    const value = body.value as { task: { mode: string; runSessionId: string; id: string } }
    expect(value.task.mode).toBe('new')
    expect(value.task.id).toBe('task-1')
    expect(value.task.runSessionId).toBe('run-1')
    expect(createdSessions).toEqual(['run-1'])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sessionId).toBe('run-1')
  })

  it('POST /mode rejects a malformed body with 400', async () => {
    const { deps } = harness()
    const { status, body } = await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/mode`, { sessionId: 'source', mode: 'sometimes' })
    expect(status).toBe(400)
    expect(body.error?.code).toBe('bad-request')
  })

  it('maps unknown and finished tasks to stable status codes', async () => {
    const { deps, rows } = harness()
    const missing = await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/mode`, { sessionId: 'source', id: 'task-nope', mode: 'new' })
    expect(missing.status).toBe(404)
    expect(missing.body.error?.code).toBe('unknown-task')
    rows[0] = { ...(rows[0] as NativeTaskView), status: 'inactive' }
    const finished = await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/mode`, { sessionId: 'source', id: 'task-1', mode: 'new' })
    expect(finished.status).toBe(409)
    expect(finished.body.error?.code).toBe('task-ended')
  })

  it('maps ambiguous recovery to 409 rather than reporting a successful switch', async () => {
    const { deps } = harness()
    deps.engine.setMode = async () => { throw new ScheduleModeError('recovery-required', 'create outcome unknown') }
    const result = await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/mode`, { sessionId: 'source', id: 'task-1', mode: 'new' })
    expect(result.status).toBe(409)
    expect(result.body.error?.code).toBe('recovery-required')
  })

  it('POST /delete removes a task and reports the boolean', async () => {
    const { deps, rows } = harness()
    const deleted = await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/delete`, { sessionId: 'source', id: 'task-1' })
    expect(deleted.status).toBe(200)
    expect(deleted.body.value).toEqual({ deleted: true })
    expect(rows).toHaveLength(0)
    const again = await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/delete`, { sessionId: 'source', id: 'task-1' })
    expect(again.body.value).toEqual({ deleted: false })
  })

  it('GET /tasks?sessionId matches both the source session and the current run session', async () => {
    const { deps } = harness()
    await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/mode`, { sessionId: 'source', id: 'task-1', mode: 'new' })
    const ids = async (sessionId: string): Promise<string[]> => {
      const { body } = await run(deps, 'GET', `${SCHEDULE_MODE_API_PREFIX}/tasks?sessionId=${sessionId}`)
      return (body.value as { tasks: Array<{ id: string }> }).tasks.map(task => task.id)
    }
    expect(await ids('source')).toEqual(['task-1'])
    expect(await ids('run-1')).toEqual(['task-1'])
    expect(await ids('unrelated')).toEqual([])
  })

  it('POST /delete accepts the run copy id from the run session and retires the policy for good', async () => {
    const { deps, rows } = harness()
    await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/mode`, { sessionId: 'source', id: 'task-1', mode: 'new' })
    const copyId = rows[0]?.id as string
    const deleted = await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/delete`, { sessionId: 'run-1', id: copyId })
    expect(deleted.body.value).toEqual({ deleted: true })
    expect(rows).toHaveLength(0)
    const refreshed = await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/refresh`, {})
    expect((refreshed.body.value as { tasks: unknown[] }).tasks).toEqual([])
    expect(rows).toHaveLength(0)
  })

  /**
   * A task id is not a capability. The armed-task fallback resolved any policy
   * by id alone, so a caller that had enumerated ids (GET /tasks in this family
   * is host-wide) could delete or re-target another conversation's scheduled
   * task by naming an unrelated session.
   */
  it('refuses a delete that names an unrelated session, even with the armed task id', async () => {
    const { deps, rows } = harness()
    await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/mode`, { sessionId: 'source', id: 'task-1', mode: 'new' })
    const copyId = rows[0]?.id as string
    const intruder = await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/delete`, { sessionId: 'intruder', id: copyId })
    expect(intruder.body.value).toEqual({ deleted: false })
    expect(rows).toHaveLength(1)

    // The row's legitimate sessions still reach it: the source session and the
    // session the copy currently runs in.
    const owner = await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/delete`, { sessionId: 'source', id: copyId })
    expect(owner.body.value).toEqual({ deleted: true })
    expect(rows).toHaveLength(0)
  })

  it('refuses a mode switch that names an unrelated session, even with the armed task id', async () => {
    const { deps, rows } = harness()
    await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/mode`, { sessionId: 'source', id: 'task-1', mode: 'new' })
    const copyId = rows[0]?.id as string
    const before = rows.map(row => ({ ...row }))
    const intruder = await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/mode`, { sessionId: 'intruder', id: copyId, mode: 'original' })
    expect(intruder.status).toBe(404)
    expect(rows).toEqual(before)

    const owner = await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/mode`, { sessionId: 'run-1', id: copyId, mode: 'original' })
    expect(owner.status).toBe(200)
    expect(rows.some(row => row.sessionId === 'source' && row.prompt === 'digest the week')).toBe(true)
  })

  it('POST /refresh reconciles and returns the list', async () => {
    const { deps } = harness()
    const { status, body } = await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/refresh`, {})
    expect(status).toBe(200)
    expect((body.value as { available: boolean }).available).toBe(true)
  })

  it('rejects non-loopback callers and unknown routes', async () => {
    const { deps } = harness()
    const remote = await run(deps, 'GET', `${SCHEDULE_MODE_API_PREFIX}/tasks`, undefined, '10.0.0.8')
    expect(remote.status).toBe(403)
    const unknown = await run(deps, 'GET', `${SCHEDULE_MODE_API_PREFIX}/nope`)
    expect(unknown.status).toBe(404)
  })

  it('rejects a body that is not valid JSON', async () => {
    const { deps } = harness()
    const { status, body } = await run(deps, 'POST', `${SCHEDULE_MODE_API_PREFIX}/mode`, '{ oops')
    expect(status).toBe(400)
    expect(body.error?.code).toBe('bad-request')
  })
})
