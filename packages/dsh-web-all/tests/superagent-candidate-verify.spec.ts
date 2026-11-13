/**
 * Host-side criterion verification (13 验收, 10 验证执行隔离).
 *
 * The subject is the rule that a candidate's own green exit code proves nothing: the
 * host re-runs the criterion command in an isolated child and only its reading may
 * fulfil. Two halves are covered: the command policy (what the host refuses to run at
 * all, and why a refusal can never be a pass) and the closure branch that turns a
 * reading into a commitment state.
 */

import { describe, expect, it } from 'vitest'
import {
  createCriterionVerifier,
  parseCriterion,
  type CommandRunner,
} from '../src/host/services/superagent/executors/candidate-verify.ts'
import { createClosure, type ExecutorFacts } from '../src/host/services/superagent/executors/closure.ts'
import type { ReportInput } from '../src/host/services/superagent/protocol/tools.ts'
import { openTestLedger, seedAttempt, seedCommitment } from './fixtures/superagent/ledger.ts'

const READY: ReportInput = { state: 'ready', summary: 'the criterion was run' }

function fakeRunner(result: { exit: number | null; stdout?: string; stderr?: string }): CommandRunner {
  return { run: async () => ({ exit: result.exit, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }) }
}

describe('the criterion command policy', () => {
  it('accepts single read-only commands', () => {
    for (const command of ['ls -la', 'grep -c foo README.md', 'git status --porcelain', 'git log --oneline -3', 'wc -l < is refused elsewhere']) {
      // `<` is shell syntax, so the last one must be refused; keep the list honest.
      const parsed = parseCriterion(command)
      if (command.includes('<')) expect('refused' in parsed).toBe(true)
      else expect('argv' in parsed).toBe(true)
    }
  })

  it('refuses anything that could write, chain or execute code', () => {
    for (const command of [
      'rm -rf build',
      'ls; rm README.md',
      'ls > out.txt',
      'cat $(whoami)',
      'echo `id`',
      'node -e "1"',
      'python3 -c "1"',
      'sh -c ls',
      'git push origin main',
      'git checkout main',
      'git config user.name x',
      'find . -delete',
      'find . -exec rm {} ;',
      'ls | head -1',
    ]) {
      expect('refused' in parseCriterion(command)).toBe(true)
    }
  })

  it('treats a metacharacter inside quotes as data, not as chaining', () => {
    // A real brief asked for `grep -c '| A ' <report>`; refusing that pattern made the
    // host reject its own verification and left a finished commitment unverified.
    expect(parseCriterion(`grep -c '| A ' /tmp/report.md`)).toEqual({ argv: ['grep', '-c', '| A ', '/tmp/report.md'] })
    expect('refused' in parseCriterion('grep -c "a;b" README.md')).toBe(false)
    expect('refused' in parseCriterion(`grep -c 'a|b' README.md`)).toBe(false)
  })
})

describe('the criterion verdict', () => {
  it('passes only when the host observed the expected exit', async () => {
    const verifier = createCriterionVerifier({ runner: fakeRunner({ exit: 0 }) })
    const reading = await verifier.verify('grep -c foo README.md', 0, '/tmp')
    expect(reading.verdict).toBe('pass')
    expect(reading.run.actualExit).toBe(0)
  })

  it('fails when the exit differs or the command never finished', async () => {
    const wrong = await createCriterionVerifier({ runner: fakeRunner({ exit: 1 }) }).verify('grep -c foo README.md', 0, '/tmp')
    expect(wrong.verdict).toBe('fail')
    const killed = await createCriterionVerifier({ runner: fakeRunner({ exit: null }) }).verify('grep -c foo README.md', 0, '/tmp')
    expect(killed.verdict).toBe('fail')
  })

  it('is inconclusive, never a pass, when the host refuses the command', async () => {
    const verifier = createCriterionVerifier({ runner: fakeRunner({ exit: 0 }) })
    const reading = await verifier.verify('rm -rf build', 0, '/tmp')
    expect(reading.verdict).toBe('inconclusive')
    expect(reading.run.refused).toBeDefined()
  })
})

describe('closure on the host reading', () => {
  class Facts implements ExecutorFacts {
    lastTurnEnd(): { turn: number; reason: 'completed' } { return { turn: 1, reason: 'completed' } }
    lastReport(): ReportInput { return READY }
    toolLog(): [] { return [] }
  }

  const close = (criterion?: Parameters<ReturnType<typeof createClosure>['close']>[3]) => {
    const t = openTestLedger()
    const commitment = seedCommitment(t, { check_kind: 'command', done_when: '`grep -c foo README.md` exits 0' })
    const attempt = seedAttempt(t, commitment.commitment_id)
    const closure = createClosure({ ledger: t.ledger, facts: new Facts(), artifacts: { pathExists: () => false, branchCommits: () => 0 } })
    const result = closure.close(attempt.attempt_id, { reason: 'completed' }, READY, criterion)
    const row = t.ledger.read.get<{ state: string; evidence_json: string | null }>(
      'SELECT state, evidence_json FROM sa_commitment WHERE commitment_id = ?', commitment.commitment_id)
    return { result, row }
  }

  it('fulfils on a passing host reading', () => {
    const { result, row } = close({ verdict: 'pass', note: 'criterion exited 0', run: { command: 'grep -c foo README.md', expectedExit: 0, actualExit: 0 } })
    expect(result.state).toBe('fulfilled')
    expect(row?.state).toBe('fulfilled')
    expect(row?.evidence_json).toContain('criterion')
  })

  it('keeps a failed reading unverified, with the reason recorded', () => {
    const { result, row } = close({ verdict: 'fail', note: 'criterion exited 1, expected 0', run: { command: 'grep -c foo README.md', expectedExit: 0, actualExit: 1 } })
    expect(result.state).toBe('unverified')
    expect(row?.state).toBe('unverified')
  })

  it('keeps an absent reading unverified, so a claim alone still close nothing', () => {
    const { result } = close()
    expect(result.state).toBe('unverified')
  })
})