import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { verificationFixture, verificationCleanup } from './fixtures/superagent/verification.ts'
import { createControlledKernel } from '../src/host/services/superagent/kernel/actions.ts'
import { prepareWorkspace } from '../src/host/services/superagent/world/workspaces.ts'
import { ManagedLedger } from '../src/host/services/superagent/kernel/managed-ledger.ts'
import { createVerificationService } from '../src/host/services/superagent/verification/index.ts'

afterEach(() => {
  for (const fn of verificationCleanup.splice(0)) fn()
})

async function passing() {
  const f = verificationFixture(),
    context = await f.seal(),
    evidence = await f.run(context)
  const evaluation = f.service.assessCandidate({ id: 'contract', revision: 1 }, f.candidate, [
    evidence
  ])
  return { ...f, context, evidence, evaluation }
}

it('derives required verification dependencies and blocks delivery when the caller omits them', async () => {
  const f = await passing()
  const repo = join(f.root, 'repo'),
    provision = join(f.root, 'workspaces')
  mkdirSync(repo)
  mkdirSync(provision)
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'test')
  writeFileSync(join(repo, 'asset'), 'baseline')
  git('add', '.')
  git('commit', '-m', 'baseline')
  const workspace = prepareWorkspace({
    source: repo,
    baseline: git('rev-parse', 'HEAD'),
    destination: join(provision, 'candidate'),
    provisioningRoot: provision
  })
  const k = createControlledKernel(f.ledger, { id: 'host', revision: 1 })
  k.host.registerWorkspace(workspace)
  const target = { id: 'commitment', revision: f.ledger.get('commitment')!.revision }
  const expiry = Date.now() + 60000
  k.host.grantCapability({
    id: 'cap',
    revision: 1,
    scopeRefs: [],
    evidenceRefs: ['local-test'],
    expiresAt: expiry,
    externalTools: 'blocked',
    revoked: false,
    launch: { executable: '/bin/sh', args: ['-c', 'true'], processPolicy: 'single' }
  })
  k.host.grantMandate({
    id: 'mandate',
    revision: 1,
    requester: 'owner',
    subject: 'worker',
    target,
    workspaceId: workspace.id,
    resourceIds: workspace.resources,
    actions: ['deliver'],
    scopeRefs: [],
    expiresAt: expiry,
    revoked: false
  })
  const control = k.host.grantControl(target, 'worker', expiry)
  const action = k.actions.planAction({
    id: 'delivery',
    idempotencyKey: 'delivery',
    requester: 'owner',
    subject: 'worker',
    target,
    epoch: control.epoch,
    mandateRef: { id: 'mandate', revision: 1 },
    capabilityRef: { id: 'cap', revision: 1 },
    kind: 'deliver',
    workspaceId: workspace.id,
    resourceIds: workspace.resources,
    scopeRefs: [],
    purpose: 'engineering',
    executable: '/bin/sh',
    args: ['-c', 'true'],
    timeoutMs: 1000,
    processPolicy: 'single'
  })
  expect(k.actions.authorizeAction(action.ref)).toMatchObject({
    kind: 'denial',
    code: 'VERIFICATION_SCOPE_REQUIRED'
  })
})

it('revokes old pass immediately before history scanning and keeps it invalid after reopen', async () => {
  const f = await passing()
  expect(f.ledger.applicability(f.evaluation.id)).toBe('usable')
  const before = f.ledger.get(f.evaluation.id)
  const revoked = f.service.revokeQualification(f.qualification, {
    reason: 'independent counterexample',
    evidenceRefs: ['review:real'],
    reviewer: 'second-qa'
  })
  expect(f.ledger.applicability(f.evaluation.id)).toBe('recheck_required')
  expect(f.service.affectedByQualification(f.qualification)).toEqual([])
  expect(() =>
    f.service.enterDelivery(
      { id: 'commitment', revision: f.ledger.get('commitment')!.revision },
      f.evaluation
    )
  ).toThrow('VERIFICATION_STALE_REFERENCE')
  const complete = f.service.scanQualificationImpacts(revoked, 1)
  expect(f.service.affectedByQualification(f.qualification)).toHaveLength(1)
  expect(f.ledger.get(f.evaluation.id)).toEqual(before)
  const reopened = new ManagedLedger(join(f.root, 'ledger.sqlite'))
  try {
    expect(reopened.applicability(f.evaluation.id)).toBe('recheck_required')
    const service = createVerificationService(
      reopened,
      { id: 'host', revision: 1 },
      join(f.root, 'verification')
    )
    service.scanQualificationImpacts(complete, 1)
    expect(service.affectedByQualification(f.qualification)).toHaveLength(1)
  } finally {
    reopened.close()
  }
})

it('keeps an evaluation valid across progress phases and ordinary method upgrades', async () => {
  const f = await passing()
  const commitment = f.ledger.get('commitment')!
  expect(commitment.data.state).toBe('verifying')
  const phase = f.service.enterDelivery(
    { id: commitment.id, revision: commitment.revision },
    f.evaluation
  )
  expect(f.ledger.get(phase.id)?.data.state).toBe('delivering')
  expect(f.ledger.applicability(f.evaluation.id)).toBe('usable')
  f.service.grantQualification({
    method: 'json-equality@1',
    reviewer: 'qa',
    evidenceRefs: ['calibration:next'],
    expiresAt: Date.now() + 60000
  })
  expect(f.ledger.applicability(f.evaluation.id)).toBe('usable')
  const requirement = f.ledger.get('requirement')!
  f.ledger.transact(
    [{ id: requirement.id, revision: requirement.revision }],
    [
      {
        kind: 'revise',
        id: requirement.id,
        data: { ...requirement.data, observable_results: ['changed required result'] }
      }
    ]
  )
  expect(f.ledger.applicability(f.evaluation.id)).toBe('recheck_required')
})

it('fences pending dispatch and delivery immediately and tracks a real earlier delivery receipt', async () => {
  const f = await passing()
  const target = f.service.enterDelivery(
    { id: 'commitment', revision: f.ledger.get('commitment')!.revision },
    f.evaluation
  )
  const kernel = f.kernel,
    expiry = Date.now() + 60000,
    scopes = f.service.requiredActionScopes('commitment')
  kernel.host.grantCapability({
    id: 'delivery-cap',
    revision: 1,
    scopeRefs: [],
    evidenceRefs: ['authorized-fixture-command'],
    expiresAt: expiry,
    externalTools: 'blocked',
    revoked: false,
    launch: {
      executable: '/bin/sh',
      args: ['-c', 'printf delivered > receipt'],
      processPolicy: 'single'
    }
  })
  kernel.host.grantMandate({
    id: 'delivery-mandate',
    revision: 1,
    requester: 'owner',
    subject: 'qa',
    target,
    workspaceId: f.workspace.id,
    resourceIds: f.workspace.resources,
    actions: ['deliver', 'dispatch'],
    scopeRefs: [],
    expiresAt: expiry,
    revoked: false
  })
  const control = kernel.host.grantControl(target, 'qa', expiry)
  const plan = (id: string, kind: 'deliver' | 'dispatch') =>
    kernel.actions.planAction({
      id,
      idempotencyKey: id,
      requester: 'owner',
      subject: 'qa',
      target,
      epoch: control.epoch,
      mandateRef: { id: 'delivery-mandate', revision: 1 },
      capabilityRef: { id: 'delivery-cap', revision: 1 },
      kind,
      workspaceId: f.workspace.id,
      resourceIds: f.workspace.resources,
      scopeRefs: scopes,
      purpose: 'collector',
      executable: '/bin/sh',
      args: ['-c', 'printf delivered > receipt'],
      timeoutMs: 1000,
      processPolicy: 'single'
    })
  const delivered = plan('delivered', 'deliver')
  kernel.actions.claimResources(delivered.ref, f.workspace.resources)
  const result = await kernel.actions.execute(delivered.ref)
  expect(result).toMatchObject({ state: 'confirmed', receipt: { stopped: true, exitCode: 0 } })
  if (!('ref' in result)) throw Error('expected actual receipt')
  const delivery = f.service.recordDelivery(f.evaluation, result.ref)
  const oldDelivery = f.ledger.get(delivery.id)
  const pending = plan('pending-delivery', 'deliver'),
    dispatch = plan('pending-dispatch', 'dispatch')
  const authorized = kernel.actions.authorizeAction(pending.ref)
  expect(authorized).toMatchObject({ kind: 'envelope' })
  if (authorized.kind !== 'envelope') throw Error('expected admitted action')
  const revoke = f.service.revokeQualification(f.qualification, {
    reason: 'calibration failed',
    evidenceRefs: ['independent:counterexample'],
    reviewer: 'second-qa'
  })
  expect(kernel.actions.authorizeAction(authorized.actionRef)).toMatchObject({
    kind: 'denial',
    code: 'STALE_SCOPE'
  })
  expect(kernel.actions.authorizeAction(dispatch.ref)).toMatchObject({ kind: 'denial' })
  f.service.scanQualificationImpacts(revoke, 1)
  expect(f.service.affectedByQualification(f.qualification)[0]?.data.delivery_refs).toEqual([
    delivery
  ])
  expect(f.ledger.get(delivery.id)).toEqual(oldDelivery)
})
