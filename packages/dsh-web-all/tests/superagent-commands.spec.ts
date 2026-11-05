/**
 * Host command contracts (T24).
 *
 * `status`, `stop`, `brief`, `calibration`, `doc` inside the service; the fenced
 * route family that exposes them; and the CLI that passes their exit codes out to
 * a shell. Fixtures: `FX/ledger.ts` (the kernel ledger over the in-memory protocol
 * database) and an in-process HTTP stub for the CLI.
 *
 * Exit codes are the contract under test, so every test names the code it expects
 * rather than only the payload: 0 success, 1 failure, 2 argument or IO error, 3 no
 * data.
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TERMINAL_STATES, type CommitmentRow } from '../src/host/services/superagent/protocol/objects.ts'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { addDoc, listDocs } from '../src/host/services/superagent/memory/docs.ts'
import {
  createCommands, type CommandDeps, type Commands, type CommandTrust, type ReleaseOutcome,
} from '../src/host/services/superagent/surface/commands/index.ts'
import {
  STATUS_MAX_LINES, buildStatus, renderStatusText, type StatusPayload,
} from '../src/host/services/superagent/surface/commands/status.ts'
import { makeCommandRoutes } from '../src/host/services/superagent/surface/routes.ts'
import { openTestLedger, seedAttempt, seedCommitment, type TestLedger } from './fixtures/superagent/ledger.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CMD_SCRIPT = join(HERE, '../../../scripts/superagent-cmd.mjs')
const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_STATES)

const commitmentState = (t: TestLedger, id: string): string =>
  (t.db.prepare('SELECT state FROM sa_commitment WHERE commitment_id = ?').get(id) as { state: string }).state

const attemptCancels = (t: TestLedger, id: string): string[] =>
  (t.db.prepare('SELECT cancel_origin FROM sa_attempt WHERE commitment_id = ? AND cancel_origin IS NOT NULL')
    .all(id) as Array<{ cancel_origin: string }>).map((row) => row.cancel_origin)

/**
 * The judgment module's release host path, as the composition root will inject it:
 * transition the promise, then cancel its live attempts with `cancel_origin='release'`.
 */
function releaseVia(t: TestLedger, commitmentId: string): ReleaseOutcome {
  return t.ledger.open((tx) => {
    const row = tx.get<CommitmentRow>('SELECT * FROM sa_commitment WHERE commitment_id = ?', commitmentId)
    if (row === undefined) return { ok: false, reason: 'missing' } as const
    if (TERMINAL.has(row.state)) return { ok: false, reason: 'terminal' } as const
    tx.transition(commitmentId, 'released')
    const live = tx.all<{ attempt_id: string }>(
      `SELECT attempt_id FROM sa_attempt WHERE commitment_id = ? AND state IN ('pending', 'running')`, commitmentId)
    for (const attempt of live) {
      tx.updateAttempt(attempt.attempt_id, { state: 'ended', end_reason: 'aborted', cancel_origin: 'release' })
    }
    return { ok: true } as const
  })
}

function deps(t: TestLedger, over: Partial<CommandDeps> = {}): CommandDeps {
  return {
    read: t.ledger.read,
    now: () => t.clock.now(),
    release: (id: string) => releaseVia(t, id),
    briefNow: async () => null,
    docs: {
      add: (path: string) => t.ledger.open(
        (tx) => addDoc(tx, path, '交接说明', 'handoff', 'human'), { module: 'memory' }),
      list: (q?: string) => listDocs(t.ledger.read, q),
    },
    ...over,
  }
}

function insertDegrade(t: TestLedger, id: string, endedAt: number | null): void {
  const now = t.clock.now()
  t.db.prepare(`INSERT INTO sa_degrade_event (degrade_id, reason, scope, started_at, ended_at, created_at, updated_at)
    VALUES (?, ?, 'write', ?, ?, ?, ?)`)
    .run(id, `reason-${id}`, now - 1_000, endedAt, now, now)
}

/**
 * The fence the composition root injects: `accessTrustOf(ctx)` in production,
 * a constant decision here so both branches are under test.
 */
function fakeTrust(trusted: boolean): CommandTrust {
  return { isTrusted: () => trusted }
}

interface FakeAnswer { statusCode: number; body: string }

/** Drives one route handler with a minimal request/response pair. */
async function invoke(route: WebRoute, options: { method?: string; args?: string[] } = {}): Promise<FakeAnswer> {
  const payload = options.args === undefined ? [] : [Buffer.from(JSON.stringify({ args: options.args }), 'utf8')]
  const request = {
    method: options.method ?? 'POST',
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() { for (const chunk of payload) yield chunk },
    destroy() { /* the oversized-body path closes the socket; nothing to do here */ },
  } as unknown as IncomingMessage
  let statusCode = 0
  let body = ''
  const response = {
    writeHead(code: number) { statusCode = code; return response },
    end(text?: string) { body = text ?? '' },
  } as unknown as ServerResponse
  await route.handler(request, response)
  return { statusCode, body }
}

describe('superagent host commands', () => {
  it('1. status --json 的在办集合与 11 的 SQL 一致，降级段只含未结束的行', async () => {
    const t = openTestLedger()
    seedCommitment(t)
    seedCommitment(t)
    const closed = seedCommitment(t)
    t.ledger.open((tx) => tx.transition(closed.commitment_id, 'released'))
    insertDegrade(t, 'D-OPEN', null)
    insertDegrade(t, 'D-DONE', t.clock.now() - 500)

    const result = await createCommands(deps(t)).run('status', ['--json'])
    expect(result.exitCode).toBe(0)
    const payload = result.json as StatusPayload
    // 独立抄写 11 的在办集合 SQL，作为第二份契约
    const expected = t.db.prepare(
      `SELECT commitment_id, state FROM sa_commitment
        WHERE state IN ('proposed','open','at_risk') ORDER BY 1`).all()
    expect(payload.open.map((row) => ({ commitment_id: row.commitment_id, state: row.state }))).toEqual(expected)
    expect(payload.open).toHaveLength(2)
    expect(payload.degrade.map((row) => row.degrade_id)).toEqual(['D-OPEN'])
    expect(payload.waiting.every((row) => row.ball !== 'me')).toBe(true)
    expect(payload.interruptsToday).toBe(0)
    expect(payload.idleRate24h).toBe(0)
    expect(payload.leaseHolder).toBeNull()
  })

  it('2. status 文本不超过一屏（40 行），多出来的行被换成计数', async () => {
    const t = openTestLedger()
    for (let index = 0; index < 60; index += 1) seedCommitment(t)
    for (let index = 0; index < 7; index += 1) insertDegrade(t, `D-${index}`, null)

    const result = await createCommands(deps(t)).run('status', [])
    expect(result.exitCode).toBe(0)
    expect(STATUS_MAX_LINES).toBe(40)
    expect(result.text.split('\n').length).toBeLessThanOrEqual(STATUS_MAX_LINES)
    // 行数上限是硬回退：压到 10 行时最后一行是计数，不是被截断的半行
    const payload = buildStatus(t.ledger.read, t.clock.now())
    const clipped = renderStatusText(payload, 10).split('\n')
    expect(clipped).toHaveLength(10)
    expect(clipped[9]).toContain('另有')
    // 参数不合只接受 --json
    expect((await createCommands(deps(t)).run('status', ['--yaml'])).exitCode).toBe(2)
  })

  it('3. stop：格式错 2、不存在 3、已终态 1、开着 0 且承诺 released 与尝试 cancel_origin=release', async () => {
    const t = openTestLedger()
    const commands = createCommands(deps(t))
    expect((await commands.run('stop', [])).exitCode).toBe(2)
    expect((await commands.run('stop', ['C-x'])).exitCode).toBe(2)
    expect((await commands.run('stop', ['C-999'])).exitCode).toBe(3)

    const live = seedCommitment(t)
    seedAttempt(t, live.commitment_id)
    const stopped = await commands.run('stop', [live.commitment_id])
    expect(stopped.exitCode).toBe(0)
    expect(commitmentState(t, live.commitment_id)).toBe('released')
    expect(attemptCancels(t, live.commitment_id)).toEqual(['release'])

    const closed = seedCommitment(t)
    t.ledger.open((tx) => tx.transition(closed.commitment_id, 'released'))
    expect((await commands.run('stop', [closed.commitment_id])).exitCode).toBe(1)
  })

  it('4. brief --now：没有内容 3；有内容 0；缺 --now 是参数错 2', async () => {
    const t = openTestLedger()
    expect((await createCommands(deps(t)).run('brief', ['--now'])).exitCode).toBe(3)
    expect((await createCommands(deps(t)).run('brief', [])).exitCode).toBe(2)

    const withBrief = createCommands(deps(t, {
      briefNow: async () => ({ body: '今天 1 件在办，没别的', items: [{ kind: 'open' }] }),
    }))
    const sent = await withBrief.run('brief', ['--now'])
    expect(sent.exitCode).toBe(0)
    expect(sent.json).toEqual({ brief: '今天 1 件在办，没别的', items: [{ kind: 'open' }] })
  })

  it('5. doc add：路径不存在 2；存在 0 且登记者是 human', async () => {
    const t = openTestLedger()
    const commands = createCommands(deps(t))
    const dir = mkdtempSync(join(tmpdir(), 'sa-cmd-doc-'))
    const file = join(dir, 'handoff.md')
    writeFileSync(file, '# 交接\n先看这里。\n', 'utf8')

    expect((await commands.run('doc', ['add', join(dir, 'nope.md')])).exitCode).toBe(2)
    const added = await commands.run('doc', ['add', file])
    expect(added.exitCode).toBe(0)
    const row = t.db.prepare('SELECT path, added_by FROM sa_doc_index').get()
    expect(row).toEqual({ path: file, added_by: 'human' })
  })

  it('6. doc list：无匹配 3；有匹配 0 并返回索引行', async () => {
    const t = openTestLedger()
    const commands = createCommands(deps(t))
    expect((await commands.run('doc', ['list', '不存在的词'])).exitCode).toBe(3)

    const dir = mkdtempSync(join(tmpdir(), 'sa-cmd-doc-'))
    const file = join(dir, 'delivery.md')
    writeFileSync(file, '# 交付\n', 'utf8')
    expect((await commands.run('doc', ['add', file])).exitCode).toBe(0)
    const listed = await commands.run('doc', ['list', 'delivery'])
    expect(listed.exitCode).toBe(0)
    const docs = (listed.json as { docs: Array<{ path: string; added_by: string }> }).docs
    expect(docs.map((doc) => doc.path)).toEqual([file])
    expect(docs[0].added_by).toBe('human')
  })

  it('7. 围栏拒绝时返回 403 且不执行命令', async () => {
    let runs = 0
    const commands: Commands = {
      async run() { runs += 1; return { json: {}, text: '', exitCode: 0 } },
    }
    const rejected = await invoke(makeCommandRoutes(commands, fakeTrust(false))[0], { args: [] })
    expect(rejected.statusCode).toBe(403)
    expect(rejected.body).toContain('forbidden')
    expect(runs).toBe(0)

    const allowed = await invoke(makeCommandRoutes(commands, fakeTrust(true))[0], { args: [] })
    expect(allowed.statusCode).toBe(200)
    expect(runs).toBe(1)

    // 方法不对同样不执行
    const wrongMethod = await invoke(makeCommandRoutes(commands, fakeTrust(true))[0], { method: 'GET' })
    expect(wrongMethod.statusCode).toBe(405)
    expect(runs).toBe(1)
  })

  it('8. superagent-cmd.mjs 把路由返回的 exitCode 原样作为进程退出码', async () => {
    const seen: Array<{ method?: string; url?: string; body: string }> = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      request.on('end', () => {
        seen.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString('utf8') })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ json: { open: [] }, text: '在办 0', exitCode: 3 }))
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
    const port = (server.address() as AddressInfo).port
    try {
      const child = spawn(process.execPath, [CMD_SCRIPT, 'status', '--json', '--port', String(port)],
        { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk) })
      const code = await new Promise<number | null>((resolve) => { child.on('exit', (exit) => resolve(exit)) })
      expect(code).toBe(3)
      expect(stdout).toContain('"open"')
      expect(seen[0]?.method).toBe('POST')
      expect(seen[0]?.url).toBe('/superagent/commands/status')
      expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ args: ['--json'] })
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
    }
  })
})