import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedLedger } from '../src/host/services/superagent/kernel/managed-ledger.ts'
import { createClosure } from '../src/host/services/superagent/executors/closure.ts'
import { openTestLedger, seedAttempt, seedCommitment } from './fixtures/superagent/ledger.ts'
import { createManualClock } from './fixtures/superagent/manual-clock.ts'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

it.each(['artifact', 'answer', 'command'] as const)(
  'ready %s cannot fulfill through existence, words or a matching tool exit',
  (check_kind) => {
    const t = openTestLedger(createManualClock(1000))
    cleanup.push(() => t.db.close())
    const c = seedCommitment(t, {
      check_kind,
      done_when: check_kind === 'command' ? '`true` exit 0' : 'exists'
    })
    const a = seedAttempt(t, c.commitment_id)
    const closure = createClosure({
      ledger: t.ledger,
      artifacts: { pathExists: () => true, branchCommits: () => 1 },
      facts: {
        lastTurnEnd: () => ({ turn: 1, reason: 'completed' }),
        lastReport: () => undefined,
        toolLog: () => [{ callId: 'real', name: 'shell', arguments: '{"cmd":"true"}', exit: 0 }]
      }
    })
    expect(
      closure.close(
        a.attempt_id,
        { reason: 'completed' },
        {
          state: 'ready',
          summary: 'exists',
          evidence: [{ command: 'true', exit: 0, reading: 'exists' }]
        }
      )
    ).toEqual({ state: 'unverified', evidenceOk: false })
  }
)

it('requires a host-controlled verification transaction instead of JSON attestation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p4-ledger-'))
  const ledger = new ManagedLedger(join(dir, 'ledger.sqlite'))
  cleanup.push(() => {
    ledger.close()
    rmSync(dir, { recursive: true, force: true })
  })
  expect(typeof (ledger as any).verification).toBe('function')
  expect(() =>
    (ledger as any).verification({ kind: 'evaluate', token: {}, data: { verdict: 'pass' } })
  ).toThrow('VERIFICATION_HOST_REQUIRED')
})
