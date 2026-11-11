import { afterEach, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { verificationFixture, verificationCleanup } from './fixtures/superagent/verification.ts'
afterEach(() => {
  for (const fn of verificationCleanup.splice(0)) fn()
})

it.each(['unrelated-input', 'changed-expectation'] as const)(
  'rejects an explicitly bound recheck with %s',
  async (variant) => {
    const f = verificationFixture(
      `export function inspect(v) { return v === 'edge' ? 'wrong' : v }`
    )
    const context = await f.seal([{ criterion: 'requirement', input: 'edge', expected: 'edge' }])
    const evidence = await f.run(context)
    const issue = f.service.recordReviewIssue({
      candidate: f.candidate,
      criterion: 'requirement',
      source: 'independent:edge',
      reproductionRefs: [evidence],
      impact: 'edge is wrong',
      responsible: 'engineer',
      releaseCondition: 'edge must return edge'
    })
    const awaiting = f.service.advanceReviewIssue(
      f.service.advanceReviewIssue(issue, 'addressing'),
      'awaiting_recheck'
    )
    await expect(
      f.service.sealVerificationContext({
        candidate: f.candidate,
        qualification: f.qualification,
        cases: [
          {
            criterion: 'requirement',
            input: variant === 'unrelated-input' ? 'expected' : 'edge',
            expected: variant === 'unrelated-input' ? 'expected' : 'wrong'
          }
        ],
        review: { issue: awaiting, purpose: 'resolve', coverageBasis: 'claims to cover edge' }
      })
    ).rejects.toThrow('ISSUE_RECHECK_COVERAGE_REQUIRED')
  }
)

it('requires the precise issue revision and purpose throughout an independent recheck', async () => {
  const f = verificationFixture()
  const evidence = await f.run(await f.seal())
  const issue = f.service.recordReviewIssue({
    candidate: f.candidate,
    criterion: 'requirement',
    source: 'independent:suspected',
    reproductionRefs: [evidence],
    impact: 'suspected mismatch',
    responsible: 'engineer',
    releaseCondition: 'independent reproduction'
  })
  const assignment = f.service.registerAssignment({
    commitmentId: 'commitment',
    contract: { id: 'contract', revision: 1 },
    requirements: [{ id: 'requirement', revision: 1 }],
    generators: ['engineer'],
    reviewer: 'other-qa'
  })
  const qualification = f.service.grantQualification({
    method: 'json-equality@1',
    reviewer: 'other-qa',
    evidenceRefs: ['independent:calibration'],
    expiresAt: Date.now() + 60000
  })
  const candidate = f.service.collectCandidate(assignment, {
    sourceRoot: f.source,
    entry: 'candidate.mjs',
    exportName: 'inspect',
    environment: 'node-local@1'
  })
  const seal = (ref: typeof issue) =>
    f.service.sealVerificationContext({
      candidate,
      qualification,
      cases: [{ criterion: 'requirement', input: 'expected', expected: 'expected' }],
      review: { issue: ref, purpose: 'dismiss', coverageBasis: 'rerun exact original reproduction' }
    })
  const stale = await seal(issue)
  const unstarted = await seal(issue)
  const staleEvidence = await f.run(stale)
  const awaiting = f.service.advanceReviewIssue(
    f.service.advanceReviewIssue(issue, 'addressing'),
    'awaiting_recheck'
  )
  await expect(f.run(unstarted)).rejects.toThrow('VERIFICATION_STALE_REFERENCE')
  expect(() =>
    f.service.assessCandidate({ id: 'contract', revision: 1 }, candidate, [staleEvidence])
  ).toThrow('VERIFICATION_STALE_REFERENCE')
  await expect(seal(issue)).rejects.toThrow('VERIFICATION_STALE_REFERENCE')
  const current = await seal(awaiting)
  const currentEvidence = await f.run(current)
  const pass = f.service.assessCandidate({ id: 'contract', revision: 1 }, candidate, [
    currentEvidence
  ])
  expect(() => f.service.resolveReviewIssue(awaiting, pass)).toThrow(
    'ISSUE_RECHECK_BINDING_REQUIRED'
  )
  const dismissed = f.service.dismissReviewIssue(
    awaiting,
    pass,
    'same API exact reproduction passes independently'
  )
  expect(f.ledger.get(dismissed.id)!.data.state).toBe('dismissed')
  expect(f.ledger.applicability(pass.id)).toBe('usable')
})

it('rechecks the concrete edge on a repaired candidate and preserves failure before delivery', async () => {
  const f = verificationFixture(`export function inspect(v) { return v === 'edge' ? 'wrong' : v }`)
  const cases = [{ criterion: 'requirement', input: 'edge', expected: 'edge' }]
  const evidence = await f.run(await f.seal(cases))
  const failed = f.service.assessCandidate({ id: 'contract', revision: 1 }, f.candidate, [evidence])
  const originalEvidence = f.ledger.get(evidence.id)
  const issue = f.service.recordReviewIssue({
    candidate: f.candidate,
    criterion: 'requirement',
    source: 'independent:edge',
    reproductionRefs: [evidence],
    impact: 'edge is wrong',
    responsible: 'engineer',
    releaseCondition: 'edge must return edge'
  })
  const awaiting = f.service.advanceReviewIssue(
    f.service.advanceReviewIssue(issue, 'addressing'),
    'awaiting_recheck'
  )
  writeFileSync(join(f.source, 'candidate.mjs'), 'export function inspect(v) { return v }')
  const candidate = f.service.collectCandidate(f.assignment, {
    sourceRoot: f.source,
    entry: 'candidate.mjs',
    exportName: 'inspect',
    environment: 'node-local@1'
  })
  const context = await f.service.sealVerificationContext({
    candidate,
    qualification: f.qualification,
    cases,
    review: {
      issue: awaiting,
      purpose: 'resolve',
      coverageBasis: 'actual edge reproduction against repaired same API'
    }
  })
  const fixedEvidence = await f.run(context)
  const passed = f.service.assessCandidate({ id: 'contract', revision: 1 }, candidate, [
    fixedEvidence
  ])
  f.service.resolveReviewIssue(awaiting, passed)
  const delivery = f.service.enterDelivery(
    { id: 'commitment', revision: f.ledger.get('commitment')!.revision },
    passed
  )
  expect(f.ledger.get(delivery.id)!.data.state).toBe('delivering')
  expect(f.ledger.get(failed.id)!.data.verdict).toBe('fail')
  expect(f.ledger.get(evidence.id)).toEqual(originalEvidence)
})

it.each(['old-pass', 'reassessed-old-evidence', 'unrelated-new-context'] as const)(
  'cannot close a new edge failure using %s',
  async (variant) => {
    const f = verificationFixture(
      `export function inspect(v) { return v === 'edge' ? 'wrong' : v }`
    )
    const ordinaryContext = await f.seal(),
      ordinaryEvidence = await f.run(ordinaryContext)
    let pass = f.service.assessCandidate({ id: 'contract', revision: 1 }, f.candidate, [
      ordinaryEvidence
    ])
    const edgeContext = await f.seal([
      { criterion: 'requirement', input: 'edge', expected: 'edge' }
    ])
    const edgeEvidence = await f.run(edgeContext)
    expect((f.ledger.get(edgeEvidence.id)!.data.results as any[])[0].verdict).toBe('fail')
    const issue = f.service.recordReviewIssue({
      candidate: f.candidate,
      criterion: 'requirement',
      source: 'independent:edge',
      reproductionRefs: [edgeEvidence],
      impact: 'edge response is wrong',
      responsible: 'engineer',
      releaseCondition: 'edge must return edge'
    })
    const addressing = f.service.advanceReviewIssue(issue, 'addressing')
    const awaiting = f.service.advanceReviewIssue(addressing, 'awaiting_recheck')
    if (variant === 'reassessed-old-evidence') {
      pass = f.service.assessCandidate({ id: 'contract', revision: 1 }, f.candidate, [
        ordinaryEvidence
      ])
    } else if (variant === 'unrelated-new-context') {
      const unrelated = await f.seal(),
        unrelatedEvidence = await f.run(unrelated)
      pass = f.service.assessCandidate({ id: 'contract', revision: 1 }, f.candidate, [
        unrelatedEvidence
      ])
    }
    expect(() => f.service.resolveReviewIssue(awaiting, pass)).toThrow(
      'ISSUE_RECHECK_BINDING_REQUIRED'
    )
    expect(() =>
      f.service.enterDelivery(
        { id: 'commitment', revision: f.ledger.get('commitment')!.revision },
        pass
      )
    ).toThrow('REVIEW_ISSUE_OPEN')
    expect(f.ledger.get(awaiting.id)!.data.state).toBe('awaiting_recheck')
  }
)

it.each(['export', 'entry'] as const)(
  'cannot dismiss a failing API by changing its %s',
  async (variant) => {
    const f = verificationFixture(
      `export function inspect() { return 'wrong' }; export function good(v) { return v }`
    )
    writeFileSync(join(f.source, 'other.mjs'), 'export function inspect(v) { return v }')
    const original = f.service.collectCandidate(f.assignment, {
      sourceRoot: f.source,
      entry: 'candidate.mjs',
      exportName: 'inspect',
      environment: 'node-local@1'
    })
    const context = await f.service.sealVerificationContext({
      candidate: original,
      qualification: f.qualification,
      cases: [{ criterion: 'requirement', input: 'expected', expected: 'expected' }]
    })
    const evidence = await f.run(context)
    const issue = f.service.recordReviewIssue({
      candidate: original,
      criterion: 'requirement',
      source: 'independent:original-api',
      reproductionRefs: [evidence],
      impact: 'original API returns wrong',
      responsible: 'engineer',
      releaseCondition: 'original API returns expected data'
    })
    const assignment = f.service.registerAssignment({
      commitmentId: 'commitment',
      contract: { id: 'contract', revision: 1 },
      requirements: [{ id: 'requirement', revision: 1 }],
      generators: ['engineer'],
      reviewer: 'other-qa'
    })
    const qualification = f.service.grantQualification({
      method: 'json-equality@1',
      reviewer: 'other-qa',
      evidenceRefs: ['independent:calibration'],
      expiresAt: Date.now() + 60000
    })
    const substitute = f.service.collectCandidate(assignment, {
      sourceRoot: f.source,
      entry: variant === 'entry' ? 'other.mjs' : 'candidate.mjs',
      exportName: variant === 'export' ? 'good' : 'inspect',
      environment: 'node-local@1'
    })
    expect(f.ledger.get(substitute.id)!.data.digest).toBe(f.ledger.get(original.id)!.data.digest)
    const substituteContext = await f.service.sealVerificationContext({
      candidate: substitute,
      qualification,
      cases: [{ criterion: 'requirement', input: 'expected', expected: 'expected' }]
    })
    const substituteEvidence = await f.run(substituteContext)
    const pass = f.service.assessCandidate({ id: 'contract', revision: 1 }, substitute, [
      substituteEvidence
    ])
    expect(f.ledger.get(pass.id)!.data.verdict).toBe('pass')
    expect(() =>
      f.service.dismissReviewIssue(issue, pass, 'different reviewer claims false positive')
    ).toThrow('REVIEW_EXECUTION_IDENTITY_REQUIRED')
    expect(f.ledger.get(issue.id)!.data.state).toBe('open')
  }
)

it('requires an independent current recheck and preserves the original finding', async () => {
  const f = verificationFixture('export function inspect() { return "wrong" }')
  const context = await f.seal(),
    evidence = await f.run(context)
  const failed = f.service.assessCandidate({ id: 'contract', revision: 1 }, f.candidate, [evidence])
  const issue = f.service.recordReviewIssue({
    candidate: f.candidate,
    criterion: 'requirement',
    source: 'user:requirement',
    reproductionRefs: [evidence],
    impact: 'user result is wrong',
    responsible: 'engineer',
    releaseCondition: 'requirement returns expected data'
  })
  expect(() => f.service.resolveReviewIssue(issue, failed)).toThrow('INDEPENDENT_RECHECK_REQUIRED')
  const addressing = f.service.advanceReviewIssue(issue, 'addressing')
  const recheck = f.service.advanceReviewIssue(addressing, 'awaiting_recheck')
  writeFileSync(join(f.source, 'candidate.mjs'), 'export function inspect(v) { return v }')
  const candidate = f.service.collectCandidate(f.assignment, {
    sourceRoot: f.source,
    entry: 'candidate.mjs',
    exportName: 'inspect',
    environment: 'node-local@1'
  })
  const fixedContext = await f.service.sealVerificationContext({
    candidate,
    qualification: f.qualification,
    review: {
      issue: recheck,
      purpose: 'resolve',
      coverageBasis: 'Rerun the original failing input against the repaired API'
    },
    cases: [{ criterion: 'requirement', input: 'expected', expected: 'expected' }]
  })
  const fixedEvidence = await f.run(fixedContext)
  const passed = f.service.assessCandidate({ id: 'contract', revision: 1 }, candidate, [
    fixedEvidence
  ])
  const resolved = f.service.resolveReviewIssue(recheck, passed)
  expect(f.ledger.get(resolved.id)?.data.state).toBe('resolved')
  expect(f.ledger.get(resolved.id)?.data.reproduction_refs).toEqual([evidence])
  expect(f.ledger.get(failed.id)?.data.verdict).toBe('fail')
  const delivery = f.service.enterDelivery(
    { id: 'commitment', revision: f.ledger.get('commitment')!.revision },
    passed
  )
  expect(f.ledger.get(delivery.id)!.data.state).toBe('delivering')
  expect(
    f.ledger
      .events()
      .some((e: any) => e.objects?.some((o: any) => o.id === issue.id && o.data.state === 'open'))
  ).toBe(true)
})

it('dismisses an evidenced false positive only through a different independent reviewer of the same artifact', async () => {
  const f = verificationFixture(),
    context = await f.seal(),
    evidence = await f.run(context)
  const first = f.service.assessCandidate({ id: 'contract', revision: 1 }, f.candidate, [evidence])
  const issue = f.service.recordReviewIssue({
    candidate: f.candidate,
    criterion: 'requirement',
    source: 'user:requirement',
    reproductionRefs: [evidence],
    impact: 'suspected mismatch',
    responsible: 'engineer',
    releaseCondition: 'independent reproduction'
  })
  expect(() => f.service.dismissReviewIssue(issue, first, 'my own opinion')).toThrow(
    'INDEPENDENT_DISMISSAL_REQUIRED'
  )
  const assignment = f.service.registerAssignment({
    commitmentId: 'commitment',
    contract: { id: 'contract', revision: 1 },
    requirements: [{ id: 'requirement', revision: 1 }],
    generators: ['engineer'],
    reviewer: 'second-qa'
  })
  const qualification = f.service.grantQualification({
    method: 'json-equality@1',
    reviewer: 'second-qa',
    evidenceRefs: ['independent:calibration'],
    expiresAt: Date.now() + 60000
  })
  const candidate = f.service.collectCandidate(assignment, {
    sourceRoot: f.source,
    entry: 'candidate.mjs',
    exportName: 'inspect',
    environment: 'node-local@1'
  })
  const secondContext = await f.service.sealVerificationContext({
    candidate,
    qualification,
    review: {
      issue,
      purpose: 'dismiss',
      coverageBasis: 'Independently rerun the same API and the original reproduction'
    },
    cases: [{ criterion: 'requirement', input: 'expected', expected: 'expected' }]
  })
  const secondEvidence = await f.run(secondContext)
  const second = f.service.assessCandidate({ id: 'contract', revision: 1 }, candidate, [
    secondEvidence
  ])
  const dismissed = f.service.dismissReviewIssue(
    issue,
    second,
    'same artifact independently returns the required result'
  )
  expect(f.ledger.get(dismissed.id)?.data.state).toBe('dismissed')
  expect(f.ledger.get(dismissed.id)?.data.reproduction_refs).toEqual([evidence])
})
