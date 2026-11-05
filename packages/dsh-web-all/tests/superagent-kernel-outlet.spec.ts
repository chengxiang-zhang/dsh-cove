/**
 * Kernel outlet and lease (T14). Fixtures: FX/ledger.ts, FX/manual-clock.ts,
 * FX/fake-channel.ts adapted to SenderPort, a stub OutletPolicy.
 */

import { describe, expect, it } from 'vitest'
import { createLease } from '../src/host/services/superagent/kernel/lease.ts'
import { createOutlet, UNSENT_NOTE } from '../src/host/services/superagent/kernel/outlet.ts'
import type { OutletPolicy, OutletVerdict, SenderPort, SpeechProposal } from '../src/host/services/superagent/kernel/ports.ts'
import { createFakeChannel, type FakeChannel } from './fixtures/superagent/fake-channel.ts'
import { openTestLedger, type TestLedger } from './fixtures/superagent/ledger.ts'

const SEC = 1000
const asSender = (ch: FakeChannel): SenderPort => ({
  send: (chatId, text, idemKey, replyTo) => ch.send(chatId, text, replyTo, idemKey),
  react: (messageId, emoji) => ch.react(messageId, emoji),
})
const policy = (verdict?: Partial<Extract<OutletVerdict, { ok: true }>> | Extract<OutletVerdict, { ok: false }>): OutletPolicy => ({
  check: p => (verdict && 'ok' in verdict && verdict.ok === false ? verdict
    : { ok: true, tier: 'reply', text: p.text, words: 2, ...(verdict as object | undefined) }),
})
const OK = policy()
let seq = 0
const proposal = (over: Partial<SpeechProposal> = {}): SpeechProposal => {
  seq += 1
  return { event_id: `evt-${seq}`, chat_id: 'oc_1', moment: 'answer', audience: 'requester', payload: 'text', text: 'on it', idem_key: `idem-${seq}`, ...over }
}
const rows = (t: TestLedger, where = '1 = 1'): Array<Record<string, unknown>> =>
  t.db.prepare(`SELECT * FROM sa_outbox WHERE ${where} ORDER BY created_at, outbox_id`).all() as Array<Record<string, unknown>>

function setup(holder = 'proc-a') {
  const t = openTestLedger()
  const lease = createLease(t.ledger)
  const outlet = createOutlet(t.ledger, lease, holder)
  const channel = createFakeChannel(() => t.clock.now())
  return { t, lease, outlet, channel, sender: asSender(channel) }
}

describe('kernel outlet and lease', () => {
  it('1. first holder takes the lease at epoch 1; a second holder does not', () => {
    const { t, lease } = setup()
    expect(lease.acquire('proc-a', t.clock.now())).toEqual({ held: true, epoch: 1, holder: 'proc-a' })
    expect(lease.acquire('proc-b', t.clock.now())).toEqual({ held: false, epoch: 1, holder: 'proc-a' })
    expect(lease.heartbeat('proc-b', t.clock.now())).toBe(false)
  })

  it('2. after 61 seconds without heartbeat another holder takes over at epoch 2', () => {
    const { t, lease } = setup()
    lease.acquire('proc-a', t.clock.now())
    t.clock.advance(15 * SEC)
    expect(lease.heartbeat('proc-a', t.clock.now())).toBe(true)
    t.clock.advance(59 * SEC)
    expect(lease.acquire('proc-b', t.clock.now()).held).toBe(false)
    t.clock.advance(2 * SEC)
    expect(lease.acquire('proc-b', t.clock.now())).toEqual({ held: true, epoch: 2, holder: 'proc-b' })
  })

  it('3. submit without the lease is NO_LEASE and writes nothing', () => {
    const { t, outlet } = setup()
    expect(outlet.submit(proposal(), OK, 'superagent')).toMatchObject({ ok: false, code: 'NO_LEASE' })
    expect(rows(t)).toHaveLength(0)
  })

  it('4. submit in shadow mode is SHADOW_NO_WRITE and writes nothing', () => {
    const { t, lease, outlet } = setup()
    lease.acquire('proc-a', t.clock.now())
    expect(outlet.submit(proposal(), OK, 'shadow')).toMatchObject({ ok: false, code: 'SHADOW_NO_WRITE' })
    expect(outlet.submit(proposal(), OK, 'responder')).toMatchObject({ ok: false, code: 'SHADOW_NO_WRITE' })
    expect(rows(t)).toHaveLength(0)
  })

  it('5. a second reply text for one event is REPLY_EXISTS; a react for it is not limited', () => {
    const { t, lease, outlet } = setup()
    lease.acquire('proc-a', t.clock.now())
    expect(outlet.submit(proposal({ event_id: 'e1' }), OK, 'superagent').ok).toBe(true)
    expect(outlet.submit(proposal({ event_id: 'e1' }), OK, 'superagent')).toMatchObject({ ok: false, code: 'REPLY_EXISTS' })
    const react = outlet.submit(proposal({ event_id: 'e1', payload: 'react', text: 'OK', reply_to: 'om_1' }), OK, 'superagent')
    expect(react).toMatchObject({ ok: true, words: 0 })
    expect(rows(t)).toHaveLength(2)
  })

  it('6. a policy refusal returns its own code and writes nothing', () => {
    const { t, lease, outlet } = setup()
    lease.acquire('proc-a', t.clock.now())
    expect(outlet.submit(proposal(), policy({ ok: false, code: 'TOO_LONG', message: '120 words' }), 'superagent'))
      .toEqual({ ok: false, code: 'TOO_LONG', message: '120 words' })
    expect(rows(t)).toHaveLength(0)
  })

  it('7. flush sends, records message_id, and passes outbox.idem_key to the channel', async () => {
    const { t, lease, outlet, channel, sender } = setup()
    lease.acquire('proc-a', t.clock.now())
    const r = outlet.submit(proposal({ idem_key: 'k-7' }), OK, 'superagent')
    expect(await outlet.flush(t.clock.now(), sender)).toEqual({ sent: 1, failed: 0, suppressed: 0, retried: 0 })
    const [row] = rows(t)
    expect(row).toMatchObject({ outbox_id: r.ok ? r.outboxId : '', state: 'sent', attempts: 1 })
    expect(row.message_id).toBe(channel.sent[0].messageId)
    expect(channel.sent[0].idemKey).toBe('k-7')
  })

  it('8. a row queued under epoch 1 is suppressed under epoch 2, not sent, with one audit line', async () => {
    const { t, lease, outlet, channel, sender } = setup()
    lease.acquire('proc-a', t.clock.now())
    outlet.submit(proposal(), OK, 'superagent')
    // proc-a loses the lease; on regaining it the epoch has moved twice past the row.
    t.clock.advance(61 * SEC)
    lease.acquire('proc-b', t.clock.now())
    t.clock.advance(61 * SEC)
    expect(lease.acquire('proc-a', t.clock.now())).toMatchObject({ held: true, epoch: 3 })
    expect(await outlet.flush(t.clock.now(), sender)).toMatchObject({ sent: 0, suppressed: 1 })
    expect(channel.sent).toHaveLength(0)
    expect(rows(t)[0]).toMatchObject({ state: 'suppressed', lease_epoch: 1 })
    expect(t.db.prepare(`SELECT count(*) AS n FROM sa_journal WHERE actor = 'outlet' AND body_json LIKE '%suppressed_stale_epoch%'`).get()).toEqual({ n: 1 })
  })

  it('9. failures retry after 30 s then 60 s; at 24 h the row fails and leaves one pending note', async () => {
    const { t, lease, outlet, channel, sender } = setup()
    lease.acquire('proc-a', t.clock.now())
    outlet.submit(proposal({ chat_id: 'oc_9' }), OK, 'superagent')
    channel.failSend(new Error('network'))
    const t0 = t.clock.now()
    await outlet.flush(t0, sender)
    expect(rows(t)[0]).toMatchObject({ state: 'queued', attempts: 1, next_attempt_at: t0 + 30 * SEC })
    t.clock.advance(15 * SEC); lease.heartbeat('proc-a', t.clock.now())
    expect(await outlet.flush(t.clock.now(), sender)).toMatchObject({ sent: 0, retried: 0 })   // not due yet
    t.clock.advance(15 * SEC); lease.heartbeat('proc-a', t.clock.now())
    expect(await outlet.flush(t.clock.now(), sender)).toMatchObject({ retried: 1 })
    expect(rows(t)[0]).toMatchObject({ attempts: 2, next_attempt_at: t.clock.now() + 60 * SEC })
    t.clock.advance(24 * 3600 * SEC); lease.heartbeat('proc-a', t.clock.now())
    expect(await outlet.flush(t.clock.now(), sender)).toMatchObject({ failed: 1 })
    expect(rows(t)[0]).toMatchObject({ state: 'failed', attempts: 2 })
    expect(outlet.pendingNote('oc_9')).toBe(UNSENT_NOTE)
    expect(outlet.pendingNote('oc_9')).toBeUndefined()
  })

  it('10. a queued row never tried for 5 minutes is failed', async () => {
    const { t, lease, outlet, channel, sender } = setup()
    lease.acquire('proc-a', t.clock.now())
    outlet.submit(proposal(), OK, 'superagent')
    t.clock.advance(5 * 60 * SEC + 1)
    lease.heartbeat('proc-a', t.clock.now())
    expect(await outlet.flush(t.clock.now(), sender)).toMatchObject({ failed: 1, sent: 0 })
    expect(rows(t)[0]).toMatchObject({ state: 'failed', attempts: 0 })
    expect(channel.sent).toHaveLength(0)
  })

  it('11. the 03 I4 reading is 1 at the end', async () => {
    const { t, lease, outlet, sender } = setup()
    lease.acquire('proc-a', t.clock.now())
    outlet.submit(proposal(), OK, 'superagent')
    t.clock.advance(61 * SEC)
    lease.acquire('proc-a', t.clock.now())   // same holder: epoch unchanged
    t.clock.advance(1); lease.heartbeat('proc-a', t.clock.now())
    outlet.submit(proposal(), OK, 'superagent')
    await outlet.flush(t.clock.now(), { ...sender, send: () => Promise.reject(new Error('down')) })
    expect(t.db.prepare(`SELECT count(DISTINCT lease_epoch) AS n FROM sa_outbox WHERE state = 'queued'`).get()).toEqual({ n: 1 })
  })

  it('12. a tier field smuggled into the proposal is ignored; the policy tier wins', () => {
    const { t, lease, outlet } = setup()
    lease.acquire('proc-a', t.clock.now())
    const smuggled = { ...proposal(), tier: 'interrupt' } as SpeechProposal
    const r = outlet.submit(smuggled, policy({ tier: 'brief', words: 3 }), 'superagent')
    expect(r).toMatchObject({ ok: true, tier: 'brief', words: 3 })
    expect(rows(t)[0]).toMatchObject({ tier: 'brief', words: 3 })
  })
})
