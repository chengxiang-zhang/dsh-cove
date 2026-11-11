/**
 * Executor closure, escalation, probes and sweep (T22).
 *
 * The thirteen cases follow the T-05 spec's list. The table in `10 "结案：不信自述"`
 * is the subject of the first eight: a self-report only counts when the session's
 * own tool log agrees with it, and "do not judge yet" is a real answer for two
 * cases (unconsumed input, a report that arrives before its turn end).
 *
 * Fixtures: the real ledger (`FX/ledger.ts`) and the real profile registry, because
 * the escalation order and the attempt rows are ledger facts. Session facts come
 * from a small in-test record instead of a live controller: T19 already owns the
 * event parsing, and this file is about the judgement built on top of it.
 */

import { describe, expect, it } from 'vitest'
import {
  PENDING_CLOSE_MS,
  createClosure,
  type ArtifactProbe,
  type ExecutorFacts,
} from '../src/host/services/superagent/executors/closure.ts'
import { createEscalation } from '../src/host/services/superagent/executors/escalate.ts'
import { PROBE_TAIL, createProbeWatcher, type Probe } from '../src/host/services/superagent/executors/probes/index.ts'
import { createSessionActivityProbe } from '../src/host/services/superagent/executors/probes/session-activity.ts'
import { createSweep, type SweepPorts } from '../src/host/services/superagent/executors/sweep.ts'
import { createProfileRegistry } from '../src/host/services/superagent/executors/profiles/index.ts'
import { createWorldRegistry } from '../src/host/services/superagent/world/registry.ts'
import { DEFAULT_TABLE } from '../src/host/services/superagent/world/defaults.ts'
import type { SpeechProposal } from '../src/host/services/superagent/kernel/ports.ts'
import type { AttemptRow, CommitmentRow, EndReason } from '../src/host/services/superagent/protocol/objects.ts'
import type { ReportInput } from '../src/host/services/superagent/protocol/tools.ts'
import { createManualClock } from './fixtures/superagent/manual-clock.ts'
import { openTestLedger, seedAttempt, seedCommitment, type TestLedger } from './fixtures/superagent/ledger.ts'

const T0 = 1_762_300_000_000
const HOUR = 3_600_000

class SessionFacts implements ExecutorFacts {
  readonly ends = new Map<string, { turn: number; reason: EndReason }>()
  readonly reports = new Map<string, ReportInput>()
  readonly logs = new Map<string, { callId: string; name: string; arguments: string; exit?: number }[]>()

  lastTurnEnd(attemptId: string): { turn: number; reason: EndReason } | undefined { return this.ends.get(attemptId) }
  lastReport(attemptId: string): ReportInput | undefined { return this.reports.get(attemptId) }
  toolLog(attemptId: string): { callId: string; name: string; arguments: string; exit?: number }[] { return this.logs.get(attemptId) ?? [] }

  report(attemptId: string, report: ReportInput): ReportInput {
    this.reports.set(attemptId, report)
    return report
  }

  call(attemptId: string, command: string, exit?: number): void {
    const list = this.logs.get(attemptId) ?? []
    list.push({ callId: `c${list.length + 1}`, name: 'shell', arguments: JSON.stringify({ command }), ...(exit === undefined ? {} : { exit }) })
    this.logs.set(attemptId, list)
  }
}

interface Rig {
  t: TestLedger
  facts: SessionFacts
  artifacts: { pathExists(path: string): boolean; branchCommits(branch: string): number; setPath(exists: boolean): void; setCommits(count: number): void }
  closure: ReturnType<typeof createClosure>
  escalation: ReturnType<typeof createEscalation>
  asked: { commitmentId: string; question: string; fallback: string }[]
  spoken: SpeechProposal[]
}

function assumptionRow(t: TestLedger, commitmentId: string, question: string, fallback: string): void {
  // `sa_assumption` belongs to judgment (TABLE_OWNERS); the sink writes it there.
  t.ledger.open(tx => tx.run(
    `INSERT INTO sa_assumption (commitment_id, ordinal, question, taken, reversible, mode, status, resolved_by, created_at, updated_at)
      VALUES (?, 1, ?, ?, 1, 'asked', 'open', NULL, ?, ?)`,
    commitmentId, question, fallback, T0, T0), { module: 'judgment' })
}

function rig(options: { blockedAs?: (report: ReportInput) => 'technical' | 'product' } = {}): Rig {
  const t = openTestLedger(createManualClock(T0))
  const facts = new SessionFacts()
  let pathExists = false
  let commits = 0
  const artifacts: Rig['artifacts'] = {
    pathExists: () => pathExists,
    branchCommits: () => commits,
    setPath: (exists) => { pathExists = exists },
    setCommits: (count) => { commits = count },
  }
  const asked: Rig['asked'] = []
  const spoken: SpeechProposal[] = []
  const ask = (commitmentId: string, question: string, fallback: string): void => {
    asked.push({ commitmentId, question, fallback })
    assumptionRow(t, commitmentId, question, fallback)
  }
  const artifactsPort: ArtifactProbe = { pathExists: artifacts.pathExists, branchCommits: artifacts.branchCommits }
  const closure = createClosure({ ledger: t.ledger, facts, artifacts: artifactsPort, blockedAs: options.blockedAs, ask })
  const escalation = createEscalation({ ledger: t.ledger, profiles: createProfileRegistry(), clock: t.clock, speak: (p) => spoken.push(p), ask })
  return { t, facts, artifacts, closure, escalation, asked, spoken }
}

function commitmentOf(t: TestLedger, id: string): CommitmentRow {
  return t.ledger.read.get<CommitmentRow>('SELECT * FROM sa_commitment WHERE commitment_id = ?', id) as CommitmentRow
}

function attemptOf(t: TestLedger, id: string): AttemptRow {
  return t.ledger.read.get<AttemptRow>('SELECT * FROM sa_attempt WHERE attempt_id = ?', id) as AttemptRow
}

const ready = (over: Partial<ReportInput> = {}): ReportInput => ({ state: 'ready', summary: 'done', ...over })

describe('superagent executors closure', () => {
  it('1. unconsumed input means the commitment is not judged at all', () => {
    const r = rig()
    const c = seedCommitment(r.t, { check_kind: 'command', done_when: '`pnpm test` 期望退出码 0' })
    const a = seedAttempt(r.t, c.commitment_id)
    r.t.ledger.open(tx => tx.append(c.commitment_id, { actor: 'owner', kind: 'amend', request_id: 'req-1', body: { text: 'also cover X' } }))

    const result = r.closure.close(a.attempt_id, { reason: 'completed' }, ready({ evidence: [{ command: 'pnpm test', exit: 0, reading: 'ok' }] }))
    expect(result).toEqual({ state: 'pending_close', evidenceOk: false })
    // The input has not been eaten yet, so the commitment is still open (R23).
    expect(commitmentOf(r.t, c.commitment_id).state).toBe('open')
    expect(attemptOf(r.t, a.attempt_id).state).not.toBe('ended')
  })

  it('2. a command report and real tool exit remain a candidate requiring independent verification', () => {
    const r = rig()
    const c = seedCommitment(r.t, { check_kind: 'command', done_when: '`pnpm test` 期望退出码 0' })
    const a = seedAttempt(r.t, c.commitment_id)
    r.facts.call(a.attempt_id, 'pnpm test', 0)

    const result = r.closure.close(a.attempt_id, { reason: 'completed' },
      ready({ evidence: [{ command: 'pnpm test', exit: 0, reading: 'Tests 12 passed' }] }))
    expect(result.state).toBe('unverified')
    expect(result.evidenceOk).toBe(false)

    const closed = commitmentOf(r.t, c.commitment_id)
    expect(closed.state).toBe('unverified')
    expect(closed.evidence_json).toBeNull()
    // The reading 10 asks for: nothing is fulfilled without evidence.
    const bare = r.t.ledger.read.get<{ n: number }>(`SELECT count(*) AS n FROM sa_commitment WHERE state = 'fulfilled' AND evidence_json IS NULL`)
    expect(bare?.n).toBe(0)
    expect(attemptOf(r.t, a.attempt_id)).toMatchObject({ state: 'ended', end_reason: 'completed' })
  })

  it('3. the same command with a different exit code is only unverified', () => {
    const r = rig()
    const c = seedCommitment(r.t, { check_kind: 'command', done_when: '`pnpm test` 期望退出码 0' })
    const a = seedAttempt(r.t, c.commitment_id)
    // The session actually failed; the report claims success.
    r.facts.call(a.attempt_id, 'pnpm test', 1)

    const result = r.closure.close(a.attempt_id, { reason: 'completed' },
      ready({ evidence: [{ command: 'pnpm test', exit: 0, reading: 'looks fine' }] }))
    expect(result).toEqual({ state: 'unverified', evidenceOk: false })
    expect(commitmentOf(r.t, c.commitment_id).state).toBe('unverified')
  })

  it('4. ready without evidence is unverified, never fulfilled', () => {
    const r = rig()
    const c = seedCommitment(r.t, { check_kind: 'command', done_when: '`pnpm test` 期望退出码 0' })
    const a = seedAttempt(r.t, c.commitment_id)
    r.facts.call(a.attempt_id, 'pnpm test', 0)

    expect(r.closure.close(a.attempt_id, { reason: 'completed' }, ready())).toEqual({ state: 'unverified', evidenceOk: false })
    // A completed turn with no terminal report at all lands in the same place.
    const second = seedCommitment(r.t, { check_kind: 'command', done_when: '`pnpm test` 期望退出码 0' })
    const b = seedAttempt(r.t, second.commitment_id)
    expect(r.closure.close(b.attempt_id, { reason: 'completed' })).toEqual({ state: 'unverified', evidenceOk: false })
  })

  it('5. artifact existence is a candidate claim, never independent acceptance', () => {
    const r = rig()
    const withCommits = seedCommitment(r.t, { check_kind: 'artifact', done_when: '/tmp/sa/out/report.md' })
    const a = seedAttempt(r.t, withCommits.commitment_id)
    r.artifacts.setCommits(2)
    expect(r.closure.close(a.attempt_id, { reason: 'completed' }, ready()).state).toBe('unverified')

    const empty = seedCommitment(r.t, { check_kind: 'artifact', done_when: '/tmp/sa/out/none.md' })
    const b = seedAttempt(r.t, empty.commitment_id)
    r.artifacts.setCommits(0)
    r.artifacts.setPath(false)
    expect(r.closure.close(b.attempt_id, { reason: 'completed' }, ready())).toEqual({ state: 'unverified', evidenceOk: false })
  })

  it('6. a technical block self-heals; a product block asks exactly one question', () => {
    const technical = rig()
    const c1 = seedCommitment(technical.t)
    const a1 = seedAttempt(technical.t, c1.commitment_id)
    const blockedReport: ReportInput = { state: 'blocked', summary: 'no network in the sandbox', question: 'may I use the proxy?' }
    expect(technical.closure.close(a1.attempt_id, { reason: 'completed' }, blockedReport).state).toBe('escalate')
    expect(technical.asked).toHaveLength(0)
    expect(commitmentOf(technical.t, c1.commitment_id).state).toBe('open')

    const product = rig({ blockedAs: (report) => (report.question?.includes('scope') === true ? 'product' : 'technical') })
    const c2 = seedCommitment(product.t)
    const a2 = seedAttempt(product.t, c2.commitment_id)
    expect(product.closure.close(a2.attempt_id, { reason: 'completed' },
      { state: 'blocked', summary: 'two readings of the acceptance', question: 'which scope counts?' }))
      .toEqual({ state: 'pending_close', evidenceOk: false })
    expect(product.asked).toHaveLength(1)
    // One asked assumption, still unanswered, and the commitment stays open.
    const asked = product.t.ledger.read.all<{ question: string; status: string }>(
      `SELECT question, status FROM sa_assumption WHERE commitment_id = ?`, c2.commitment_id)
    expect(asked).toEqual([{ question: 'which scope counts?', status: 'open' }])
    expect(commitmentOf(product.t, c2.commitment_id).state).toBe('open')
  })

  it('7. forked or unknown end reasons escalate (unknown counts as failure)', () => {
    const r = rig()
    const forked = seedCommitment(r.t)
    const a = seedAttempt(r.t, forked.commitment_id)
    expect(r.closure.close(a.attempt_id, { reason: 'forked' }, ready()).state).toBe('escalate')

    const unknown = seedCommitment(r.t)
    const b = seedAttempt(r.t, unknown.commitment_id)
    expect(r.closure.close(b.attempt_id, { reason: 'unknown' }, ready()).state).toBe('escalate')
    // Neither commitment was closed by a guess.
    expect(commitmentOf(r.t, forked.commitment_id).state).toBe('open')
    expect(commitmentOf(r.t, unknown.commitment_id).state).toBe('open')
  })

  it('8. a ready report before its turn end waits, then the sweep judges it', () => {
    const r = rig()
    const c = seedCommitment(r.t, { check_kind: 'command', done_when: '`pnpm test` 期望退出码 0' })
    const a = seedAttempt(r.t, c.commitment_id)
    r.facts.call(a.attempt_id, 'pnpm test', 0)

    expect(r.closure.noteReady(a.attempt_id, ready({ evidence: [{ command: 'pnpm test', exit: 0, reading: 'ok' }] })))
      .toEqual({ state: 'pending_close', evidenceOk: false })
    // Not yet: ten minutes have not passed.
    expect(r.closure.pendingSweep(T0)).toBe(0)
    expect(commitmentOf(r.t, c.commitment_id).state).toBe('open')

    r.t.clock.advance(PENDING_CLOSE_MS + 60_000)
    expect(r.closure.pendingSweep(T0 + PENDING_CLOSE_MS + 60_000)).toBe(1)
    // A timed-out ready claim still cannot substitute for independent acceptance.
    expect(commitmentOf(r.t, c.commitment_id).state).toBe('unverified')
  })

  it('9. escalation walks retry then upgrade then broken, without any interrupt', () => {
    const r = rig()
    const c = seedCommitment(r.t, { check_kind: 'command', done_when: '`pnpm test` 期望退出码 0' })
    const first = seedAttempt(r.t, c.commitment_id, { executor: 'durable-full', lifetime: 'durable' })
    r.t.ledger.open(tx => tx.updateAttempt(first.attempt_id, { state: 'ended', end_reason: 'interrupted' }))

    const retry = r.escalation.escalate(c.commitment_id, 'stall')
    expect(retry.action).toBe('retry')
    expect(attemptOf(r.t, String(retry.attemptId))).toMatchObject({ executor: 'durable-full', state: 'pending', n: 2 })

    r.t.ledger.open(tx => tx.updateAttempt(String(retry.attemptId), { state: 'ended', end_reason: 'interrupted' }))
    const upgrade = r.escalation.escalate(c.commitment_id, 'stall')
    expect(upgrade.action).toBe('upgrade')
    expect(attemptOf(r.t, String(upgrade.attemptId))).toMatchObject({ executor: 'durable-full-strong', n: 3 })

    r.t.ledger.open(tx => tx.updateAttempt(String(upgrade.attemptId), { state: 'ended', end_reason: 'interrupted' }))
    expect(r.escalation.escalate(c.commitment_id, 'stall')).toEqual({ action: 'broken' })
    expect(commitmentOf(r.t, c.commitment_id).state).toBe('broken')

    // One `cannot` line for the outlet, and nothing that interrupts the owner (G9).
    expect(r.spoken).toHaveLength(1)
    expect(r.spoken[0]).toMatchObject({ moment: 'cannot', commitment_id: c.commitment_id })
    expect(r.spoken.filter((p) => (p as { tier?: string }).tier === 'interrupt')).toHaveLength(0)
    expect(r.asked).toHaveLength(0)
  })

  it('10. a loop goes straight to a higher tier, and with no higher tier it breaks', () => {
    const r = rig()
    const c = seedCommitment(r.t, { check_kind: 'command', done_when: '`pnpm test` 期望退出码 0' })
    const a = seedAttempt(r.t, c.commitment_id, { executor: 'durable-full', lifetime: 'durable' })
    r.t.ledger.open(tx => tx.updateAttempt(a.attempt_id, { state: 'ended', end_reason: 'error' }))

    const upgrade = r.escalation.escalate(c.commitment_id, 'loop')
    expect(upgrade.action).toBe('upgrade')
    expect(attemptOf(r.t, String(upgrade.attemptId)).executor).toBe('durable-full-strong')

    const top = seedCommitment(r.t, { check_kind: 'command', done_when: '`pnpm test` 期望退出码 0' })
    const topAttempt = seedAttempt(r.t, top.commitment_id, { executor: 'durable-full-strong', lifetime: 'durable' })
    r.t.ledger.open(tx => tx.updateAttempt(topAttempt.attempt_id, { state: 'ended', end_reason: 'error' }))
    expect(r.escalation.escalate(top.commitment_id, 'loop')).toEqual({ action: 'broken' })
    expect(commitmentOf(r.t, top.commitment_id).state).toBe('broken')
  })

  it('11. a stop-loss abort parks the commitment at risk with the ball back', () => {
    const r = rig()
    const c = seedCommitment(r.t, { check_kind: 'command', done_when: '`pnpm test` 期望退出码 0' })
    const a = seedAttempt(r.t, c.commitment_id)
    r.t.ledger.open(tx => tx.updateAttempt(a.attempt_id, { state: 'ended', end_reason: 'aborted', cancel_origin: 'budget' }))

    expect(r.closure.close(a.attempt_id, { reason: 'aborted' })).toEqual({ state: 'at_risk', evidenceOk: false })
    expect(commitmentOf(r.t, c.commitment_id)).toMatchObject({ state: 'at_risk', ball: 'me' })
    // A release is the owner's decision and closes the commitment instead.
    const released = seedCommitment(r.t)
    const b = seedAttempt(r.t, released.commitment_id)
    r.t.ledger.open(tx => tx.updateAttempt(b.attempt_id, { state: 'ended', end_reason: 'aborted', cancel_origin: 'release' }))
    expect(r.closure.close(b.attempt_id, { reason: 'aborted' }).state).toBe('released')
  })

  it('12. the probe reads only the tail and three failures break the commitment', async () => {
    const r = rig()
    const c = seedCommitment(r.t, { kind: 'watch', target: 'netbird/pc-tower/session/s-88' })
    let inspected = 0
    const events = Array.from({ length: PROBE_TAIL + 50 }, (_unused, index) => ({
      type: index === PROBE_TAIL + 40 ? 'tool/call' : 'turn/start',
      seq: index,
      time: T0 - 60_000,
      data: index === PROBE_TAIL + 40 ? { name: 'ssh_exec', arguments: '{"command":"uptime"}' } : { turn: index },
    }))
    const probe = createSessionActivityProbe({
      inspect: async () => {
        inspected += 1
        return { meta: { cwd: '/tmp' }, events }
      },
      now: () => T0,
    })

    const readings = await probe.probe('netbird/pc-tower/session/s-88', AbortSignal.timeout(1_000))
    // F2: inspect returns everything, so the probe takes the tail of 200 itself.
    expect(readings.find((reading) => reading.name === 'event_count')?.value).toBe(PROBE_TAIL)
    expect(readings.find((reading) => reading.name === 'last_tool')?.value).toBe('ssh_exec')
    expect(inspected).toBe(1)

    const broken: string[] = []
    const watcher = createProbeWatcher({
      onBroken: (commitmentId) => {
        broken.push(commitmentId)
        r.t.ledger.open(tx => {
          tx.append(commitmentId, { actor: 'executors', kind: 'state', body: { probe_failed: commitmentId } })
          return tx.transition(commitmentId, 'broken', { ball: 'me' })
        })
      },
    })
    const failing: Probe = { name: 'session-activity', probe: async () => { throw new Error('unreachable host') } }
    expect((await Promise.all([1, 2, 3].map(async () => watcher.watch(failing, c.commitment_id, 'netbird/pc-tower/session/s-88')))).at(-1))
      .toMatchObject({ ok: false, broken: true, failures: 3 })
    expect(broken).toEqual([c.commitment_id])
    expect(commitmentOf(r.t, c.commitment_id).state).toBe('broken')
    // Broken stops the retries: a fourth attempt does not probe again.
    expect(await watcher.watch(failing, c.commitment_id, 'netbird/pc-tower/session/s-88')).toMatchObject({ broken: true, failures: 3 })
  })

  it('13. the sweep reports twice before it deletes, and never touches a dirty directory', () => {
    const r = rig()
    const world = createWorldRegistry({ read: r.t.ledger.read, clock: r.t.clock, defaults: DEFAULT_TABLE })
    const clean = seedCommitment(r.t)
    const dirty = seedCommitment(r.t)
    const cleanPath = 'local/~/sa/work/C-1'
    const dirtyPath = 'local/~/sa/work/C-2'
    for (const [path, id] of [[cleanPath, clean.commitment_id], [dirtyPath, dirty.commitment_id]] as const) {
      r.t.ledger.open(tx => tx.run(
        `INSERT INTO sa_workspace (path, entity_id, commitment_id, mandate_id, branch, removed_at, created_at, updated_at)
          VALUES (?, 'local', ?, 'M:test', ?, NULL, ?, ?)`, path, id, `sa/${id}`, T0, T0), { module: 'world' })
      r.t.ledger.open(tx => tx.transition(id, 'fulfilled', { evidence_json: '{"artifact":"done"}' }))
    }

    const removed: string[] = []
    const branches: string[] = []
    const ports: SweepPorts = {
      hasUncommittedChanges: (dir) => dir === dirtyPath,
      removeDir: (dir) => { removed.push(dir) },
      listBranches: () => [`sa/${clean.commitment_id}`, `sa/${dirty.commitment_id}`, 'dev'],
      removeBranch: (branch) => { branches.push(branch) },
    }
    const sweep = createSweep({ ledger: r.t.ledger, ports, world })
    const now = T0 + 25 * HOUR

    const first = sweep.sweep(now)
    expect(first.dryRun).toBe(true)
    expect(first.deleted).toEqual([])
    expect(first.candidates).toEqual([cleanPath, dirtyPath, `sa/${clean.commitment_id}`, `sa/${dirty.commitment_id}`].sort())

    const second = sweep.sweep(now)
    expect(second.dryRun).toBe(false)
    // The clean directory and both branches go; the dirty one stays on disk.
    expect(second.deleted).toEqual([cleanPath, `sa/${clean.commitment_id}`, `sa/${dirty.commitment_id}`].sort())
    expect(removed).toEqual([cleanPath])
    expect(branches.sort()).toEqual([`sa/${clean.commitment_id}`, `sa/${dirty.commitment_id}`].sort())
    const rows = r.t.ledger.read.all<{ path: string; removed_at: number | null }>(
      'SELECT path, removed_at FROM sa_workspace ORDER BY path')
    expect(rows).toEqual([{ path: cleanPath, removed_at: now }, { path: dirtyPath, removed_at: null }])
  })
})