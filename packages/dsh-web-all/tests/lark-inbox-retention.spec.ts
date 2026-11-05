/**
 * Retention contracts.
 *
 * The queue index answers two questions - what is pending, and what did we do -
 * and neither needs rows from months ago. What must never happen is pruning the
 * wrong rows: an unfinished message, or a job whose batch is still waiting. The
 * JSONL shards are the durable record and are not touched here at all.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INBOX_EVENT_TYPE, type LarkInboxEnvelope } from '../src/core/lark-inbox/queue.ts'
import { replyJobId, replySessionId } from '../src/core/lark-inbox/reply-machine.ts'
import { InboxStore } from '../src/host/services/superagent/channels/feishu/inbox-store.ts'

const OWNER = 'ou_owner'
const CHAT = 'oc_chat'
const DAY = 86_400_000

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function store(): { store: InboxStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'web-all-lark-retention-'))
  roots.push(root)
  return { store: InboxStore.open({ rootDir: root }), root }
}

function message(index: number): LarkInboxEnvelope {
  return {
    envelopeVersion: 1,
    eventId: `evt-${index}`,
    receivedAt: new Date(1_700_000_000_000 + index).toISOString(),
    eventType: INBOX_EVENT_TYPE,
    chatType: 'p2p',
    chatId: CHAT,
    senderOpenId: OWNER,
    messageId: `om_${index}`,
    messageType: 'text',
    content: `第 ${index} 条`,
    mentionBot: false,
  }
}

/** Bind a conversation, attach one message, and finish the job if asked. */
function seedJob(harness: { store: InboxStore }, index: number, finish: boolean): string {
  const now = 1_700_000_000_000 + index
  const envelope = message(index)
  harness.store.append(envelope)
  harness.store.reply.ensureBinding({
    convKey: CHAT,
    chatId: CHAT,
    chatType: 'p2p',
    sessionId: replySessionId(CHAT, 1),
    now,
  })
  const jobId = replyJobId(envelope.messageId, envelope.eventId)
  harness.store.reply.attach({
    eventId: envelope.eventId,
    messageId: envelope.messageId ?? '',
    jobId,
    convKey: CHAT,
    replyToMessageId: envelope.messageId ?? '',
    now,
    debounceMs: 0,
  })
  harness.store.reply.claimSubmit(jobId, replySessionId(CHAT, 1), now, now + 60_000)
  harness.store.reply.markRunning(jobId, now + 60_000, now)
  harness.store.reply.bindTurn(jobId, 1, now)
  if (finish) {
    harness.store.reply.finishTurn(jobId, 'answer', '答复', 'completed', now)
    harness.store.reply.markSent(jobId, `om_sent_${index}`, now)
  }
  return jobId
}

describe('retention', () => {
  it('removes finished rows older than the cutoff and keeps unfinished ones', () => {
    const harness = store()
    const old = seedJob(harness, 1, true)
    const fresh = seedJob(harness, 2, true)
    const open = seedJob(harness, 3, false)

    // The seeds differ by one millisecond, so the cutoff falls exactly between the
    // job that should go and the one that should stay.
    const cutoff = 1_700_000_000_002
    harness.store.reply.pruneTerminal(cutoff)
    harness.store.pruneTerminal(cutoff)

    expect(harness.store.reply.job(old)).toBeUndefined()
    expect(harness.store.reply.job(fresh)).toBeDefined()
    // A job under way must survive: its batch is still the only record of what the
    // person asked.
    expect(harness.store.reply.job(open)?.state).toBe('running')
  })

  it('never prunes a queue row that is still pending', () => {
    const harness = store()
    harness.store.append(message(9))
    expect(harness.store.stats().pending).toBe(1)
    harness.store.pruneTerminal(Number.MAX_SAFE_INTEGER)
    expect(harness.store.stats().pending).toBe(1)
  })

  it('keeps the JSONL shard even when the index row is gone', () => {
    const harness = store()
    seedJob(harness, 1, true)
    const shards = () => readdirSync(harness.root, { recursive: true }).map(String).filter(name => name.endsWith('.jsonl'))
    const before = shards()
    expect(before.length).toBeGreaterThan(0)

    harness.store.reply.pruneTerminal(Number.MAX_SAFE_INTEGER)
    harness.store.pruneTerminal(Number.MAX_SAFE_INTEGER)

    expect(harness.store.stats().total).toBe(0)
    // The line on disk is what the platform actually sent; pruning the index is
    // housekeeping, pruning this would be deleting evidence.
    expect(shards()).toEqual(before)
  })

  it('does not delete a queue row a surviving job still points at', () => {
    const harness = store()
    const jobId = seedJob(harness, 4, false)
    // Prune with a cutoff that catches the queue row but not the live job: the
    // membership guard is what keeps the foreign key honest here.
    harness.store.pruneTerminal(Number.MAX_SAFE_INTEGER)
    expect(harness.store.get('evt-4')).toBeDefined()
    expect(harness.store.reply.job(jobId)?.state).toBe('running')
  })
})
