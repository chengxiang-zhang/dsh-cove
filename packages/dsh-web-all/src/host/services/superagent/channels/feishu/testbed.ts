/**
 * The live test harness: a deterministic inbound seam and a capture egress.
 *
 * The real end-to-end chain is the socket, the queue, the claim, the desk, the
 * outlet and the Feishu sender. Every one of those is reachable only from a
 * running host, which makes the only honest test the one that drives the running
 * host - but a test that needs a person to type in Feishu cannot be repeated, and
 * a test whose egress is the real bot posts into a real conversation.
 *
 * So this module replaces exactly two ends and nothing else:
 *
 * - Inbound: `POST /superagent/test/inbound` takes the same raw Feishu v2 event
 *   the socket would have delivered and runs the same `ingest` function (parse,
 *   gate, append, admit). Claim, desk, rules, ledger and outlet are untouched.
 * - Outbound: the reply sender is a recorder. It writes one JSONL row per send or
 *   reaction and returns a synthetic message id, so the ledger's `sent` state and
 *   the words the desk wrote can be asserted without the bot speaking to anyone.
 *
 * Both are off unless `lark-inbox.testHarness` is true, and the route also
 * refuses anything that is not a trusted (loopback or declared authority) request
 * - the same fence every privileged family uses. Production profiles leave the
 * flag at its default and this file never runs.
 *
 * @module dsh-web-all/superagent/channels/feishu/testbed
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { InboxReplySender } from './tools.ts'

/** The one route this harness adds. */
export const TEST_INGRESS_PATH = '/superagent/test/inbound'
/** The file the capture egress appends to, under the queue directory. */
export const TEST_EGRESS_FILE = 'test-egress.jsonl'
const BODY_LIMIT = 256 * 1024

/** One captured outbound message. */
export interface TestEgressRow {
  at: number
  kind: 'text' | 'react'
  chatId?: string
  /** The message this line answers or reacts to. */
  replyTo?: string
  idemKey?: string
  text?: string
  emoji?: string
  /** The id the sender returned to the outlet. */
  messageId: string
}

/** The sender shape the domain expects: `send` plus the best-effort reaction. */
export interface TestEgressPorts extends InboxReplySender {
  react(messageId: string, emojiType: string): Promise<boolean>
}

export interface TestEgress {
  sender: TestEgressPorts
  file: string
  rows(): readonly TestEgressRow[]
}

/**
 * Build the recording egress.
 * @param rootDir - the queue directory (`$DSH_HOME/lark-inbox`), the same place the ledger lives.
 * @returns the sender port, the file it wrote and the rows captured so far.
 */
export function createTestEgress(rootDir: string): TestEgress {
  const rows: TestEgressRow[] = []
  const file = join(rootDir, TEST_EGRESS_FILE)
  mkdirSync(rootDir, { recursive: true, mode: 0o700 })
  let seq = 0
  const record = (row: TestEgressRow): void => {
    rows.push(row)
    appendFileSync(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
  const sender: TestEgressPorts = {
    async send(to, text, target) {
      seq += 1
      const messageId = `om_test_${String(seq)}`
      record({
        at: Date.now(), kind: 'text', chatId: to, messageId,
        ...(target?.replyToMessageId === undefined ? {} : { replyTo: target.replyToMessageId }),
        ...(target?.idempotencyKey === undefined ? {} : { idemKey: target.idempotencyKey }),
        text,
      })
      return { ok: true, messageId }
    },
    async react(messageId, emojiType) {
      seq += 1
      record({ at: Date.now(), kind: 'react', replyTo: messageId, emoji: emojiType, messageId: `om_test_${String(seq)}` })
      return true
    },
  }
  return { sender, file, rows: () => rows }
}

/** What the ingress route needs from the domain it drives. */
export interface TestIngressDeps {
  /** The shared access fence: loopback or a declared authority with a session. */
  isTrusted(request: IncomingMessage): boolean
  /** The harness is configured on right now; read per request like every setting. */
  enabled(): boolean
  /** The exact inbound path the socket runs: parse, gate, append, admit. */
  ingest(raw: unknown, mentionBot: boolean): { stored: 'appended' | 'duplicate' | 'rejected'; reason?: string }
  log(message: string): void
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** `{ raw: <Feishu v2 event>, mentionBot?: boolean }`, or null when unreadable. */
async function readRaw(request: IncomingMessage): Promise<{ raw: unknown; mentionBot: boolean } | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > BODY_LIMIT) { request.destroy(); return null }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const body = parsed as Record<string, unknown>
    if (body.raw === undefined) return null
    return { raw: body.raw, mentionBot: body.mentionBot === true }
  } catch { return null }
}

/**
 * Build the test ingress route.
 *
 * The route is registered unconditionally and refuses per request, because the
 * settings document can flip the flag live and a route that mounted only at boot
 * would need a restart to be tested - exactly what this harness exists to avoid.
 * @param deps - fence, live flag, the domain's ingest and its logger.
 * @returns the one exact route.
 */
export function makeTestIngressRoutes(deps: TestIngressDeps): WebRoute[] {
  return [{
    kind: 'exact' as const,
    path: TEST_INGRESS_PATH,
    async handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
      if (!deps.isTrusted(request)) { writeJson(response, 403, { error: 'forbidden: loopback-only' }); return }
      if (request.method !== 'POST') { writeJson(response, 405, { error: 'method-not-allowed' }); return }
      if (!deps.enabled()) { writeJson(response, 404, { error: 'test-harness-disabled' }); return }
      const body = await readRaw(request)
      if (body === null) { writeJson(response, 400, { error: 'body-not-readable' }); return }
      try {
        const result = deps.ingest(body.raw, body.mentionBot)
        writeJson(response, result.stored === 'rejected' ? 422 : 200, result)
      } catch (error) {
        // A store failure is the platform's matter in production (non-200 lets it
        // redeliver). Here it is a test failure worth seeing verbatim.
        const message = error instanceof Error ? error.message : String(error)
        deps.log(`test ingress failed: ${message}`)
        writeJson(response, 500, { stored: 'error', reason: message })
      }
    },
  }]
}