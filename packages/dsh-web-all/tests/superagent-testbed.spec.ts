/**
 * The live test harness (testbed.ts).
 *
 * Two ends of the real chain are replaceable so an acceptance run does not need a
 * person typing in Feishu nor a message posted into a real conversation: the
 * inbound route feeds the domain's own `ingest`, and the recording sender writes
 * what the desk said instead of calling the platform. These cases pin the contract
 * of both ends - the fence, the live flag, the body shape and the capture file -
 * because a harness that silently accepts anything would make every later reading
 * worthless.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  createTestEgress, makeTestIngressRoutes, TEST_EGRESS_FILE, TEST_INGRESS_PATH,
} from '../src/host/services/superagent/channels/feishu/testbed.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-testbed-'))
  dirs.push(dir)
  return dir
}

/** A request body as an async iterable, which is all the route reads. */
function request(method: string, body = ''): IncomingMessage {
  return {
    method,
    async *[Symbol.asyncIterator]() { if (body !== '') yield Buffer.from(body) },
    destroy() { /* the route only destroys oversized bodies; none here */ },
  } as unknown as IncomingMessage
}

function response(): { res: ServerResponse; status: number; body: string } {
  const state = { status: 0, body: '' }
  const res = {
    writeHead(status: number) { state.status = status },
    end(text: string) { state.body = text },
  } as unknown as ServerResponse
  return {
    res,
    get status() { return state.status },
    get body() { return state.body },
  }
}

function route(options: { trusted?: boolean; enabled?: boolean; result?: ReturnType<Parameters<typeof makeTestIngressRoutes>[0]['ingest']> } = {}): WebRoute {
  return makeTestIngressRoutes({
    isTrusted: () => options.trusted ?? true,
    enabled: () => options.enabled ?? true,
    ingest: () => options.result ?? { stored: 'appended' },
    log: () => undefined,
  })[0] as WebRoute
}

async function call(target: WebRoute, req: IncomingMessage): Promise<{ status: number; body: string }> {
  const res = response()
  await target.handler(req, res.res)
  return { status: res.status, body: res.body }
}

describe('the capture egress', () => {
  it('1. records text and reactions to one JSONL file and answers with synthetic ids', async () => {
    const dir = tempDir()
    const egress = createTestEgress(dir)

    await expect(egress.sender.send('oc_1', '改完了；退出码 0。', { replyToMessageId: 'om_1', idempotencyKey: 'sa:1' }))
      .resolves.toEqual({ ok: true, messageId: 'om_test_1' })
    await expect(egress.sender.react('om_2', 'OK')).resolves.toBe(true)

    expect(egress.rows()).toHaveLength(2)
    expect(egress.rows()[0]).toMatchObject({ kind: 'text', chatId: 'oc_1', replyTo: 'om_1', idemKey: 'sa:1', text: '改完了；退出码 0。' })
    expect(egress.rows()[1]).toMatchObject({ kind: 'react', replyTo: 'om_2', emoji: 'OK' })

    const lines = readFileSync(join(dir, TEST_EGRESS_FILE), 'utf8').trim().split('\n').map(line => JSON.parse(line) as unknown)
    expect(lines).toHaveLength(2)
    expect(egress.file).toBe(join(dir, TEST_EGRESS_FILE))
  })
})

describe('the test ingress route', () => {
  it('2. is one exact route under the superagent prefix', () => {
    expect(TEST_INGRESS_PATH).toBe('/superagent/test/inbound')
    expect(route().path).toBe(TEST_INGRESS_PATH)
    expect(route().kind).toBe('exact')
  })

  it('3. refuses an untrusted request before reading the body', async () => {
    const res = await call(route({ trusted: false }), request('POST', '{not json'))
    expect(res.status).toBe(403)
  })

  it('4. refuses a non-POST method', async () => {
    expect((await call(route(), request('GET'))).status).toBe(405)
  })

  it('5. refuses when the harness is not configured on', async () => {
    const res = await call(route({ enabled: false }), request('POST', JSON.stringify({ raw: {} })))
    expect(res.status).toBe(404)
  })

  it('6. rejects a body without the raw event', async () => {
    expect((await call(route(), request('POST', 'nope'))).status).toBe(400)
  })

  it('7. runs the domain ingest with the raw event and reports what it did', async () => {
    let seen: { raw: unknown; mentionBot: boolean } | undefined
    const target = makeTestIngressRoutes({
      isTrusted: () => true,
      enabled: () => true,
      ingest: (raw, mentionBot) => { seen = { raw, mentionBot }; return { stored: 'appended' } },
      log: () => undefined,
    })[0] as WebRoute
    const res = await call(target, request('POST', JSON.stringify({ raw: { schema: '2.0', event: { message: { message_id: 'om_1' } } }, mentionBot: true })))
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ stored: 'appended' })
    expect(seen).toEqual({ raw: { schema: '2.0', event: { message: { message_id: 'om_1' } } }, mentionBot: true })
  })

  it('8. reports a gate rejection as 422 and a store failure as 500', async () => {
    const rejected = await call(route({ result: { stored: 'rejected', reason: 'sender-not-allowed' } }), request('POST', JSON.stringify({ raw: {} })))
    expect(rejected.status).toBe(422)
    expect(JSON.parse(rejected.body)).toEqual({ stored: 'rejected', reason: 'sender-not-allowed' })

    const failing = makeTestIngressRoutes({
      isTrusted: () => true, enabled: () => true,
      ingest: () => { throw new Error('disk full') },
      log: () => undefined,
    })[0] as WebRoute
    const failed = await call(failing, request('POST', JSON.stringify({ raw: {} })))
    expect(failed.status).toBe(500)
    expect(JSON.parse(failed.body)).toMatchObject({ stored: 'error', reason: 'disk full' })
  })
})