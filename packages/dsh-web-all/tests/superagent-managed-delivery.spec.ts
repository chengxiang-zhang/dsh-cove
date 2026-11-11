import { createProjectKeeperFixture } from '../src/host/services/superagent/executors/project-keeper-fixture.ts'
import { readKeeperFixtureCapability, keeperFixtureRequest } from '../src/host/services/superagent/executors/project-keeper-fixture-client.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync, readdirSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalGitDelivery as createGitPort, planLocalGitDelivery } from '../src/host/services/superagent/executors/delivery/local-git.ts'
import { git, file, manifestDigest } from '../src/host/services/superagent/executors/delivery/git.ts'
import { prepareDeliveryStep } from '../src/host/services/superagent/coordination/delivery.ts'
import type { DeliveryAcceptance, DeliveryStep } from '../src/host/services/superagent/protocol/delivery.ts'
import type { ExecutionEnvelope } from '../src/host/services/superagent/kernel/actions.ts'
import { inspectDeliveryReceipt } from '../src/host/services/superagent/verification/delivery.ts'
const createLocalGitDelivery = (deps: Omit<Parameters<typeof createGitPort>[0], 'verifyReceipt'>) => createGitPort({ ...deps, verifyReceipt: inspectDeliveryReceipt })
const roots: string[] = []
const keeperClosers: (()=>Promise<void>)[] = []
afterEach(async () => {
  for (const close of keeperClosers.splice(0)) await close()
  const unlock = (path: string) => { if (!lstatSync(path).isDirectory()) return; chmodSync(path, 0o700); for (const name of readdirSync(path)) unlock(join(path, name)) }
  for (const root of roots.splice(0)) { unlock(root); rmSync(root, { recursive: true, force: true }) }
})
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'p7-'))); roots.push(base)
  const root = join(base, 'repo'), candidate = join(base, 'candidate'), storage = join(base, 'journal')
  mkdirSync(root); mkdirSync(candidate); mkdirSync(storage)
  git(root, ['init', '-b', 'dev']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@localhost'])
  writeFileSync(join(root, 'fix.txt'), 'old\n'); writeFileSync(join(root, 'user.txt'), 'original\n'); writeFileSync(join(root, 'flags.txt'), 'flags\n')
  git(root, ['add', '.']); git(root, ['commit', '-m', 'fixture baseline'])
  writeFileSync(join(root, 'user.txt'), 'staged user\n'); git(root, ['add', 'user.txt']); writeFileSync(join(root, 'user.txt'), 'unstaged user\n')
  git(root, ['update-index', '--assume-unchanged', 'flags.txt'])
  writeFileSync(join(candidate, 'fix.txt'), 'fixed\n'); chmodSync(join(candidate, 'fix.txt'), 0o755)
  const f = file(candidate, 'fix.txt')!
  const input = {
    ref: { id: 'step', revision: 1 }, targetRoot: root, realGitDir: realpathSync(join(root, '.git')), branch: 'dev' as const,
    expectedParent: git(root, ['rev-parse', 'HEAD']), candidateRoot: candidate,
    manifest: [{ path: 'fix.txt', mode: f.mode, blob: f.blob }], deletions: [], message: 'fix(test): exact local delivery', authoredAt: 1700000000,
    acceptanceRef: { id: 'acceptance', revision: 1 }, requiredGateRefs: [{ id: 'gate:test', revision: 1 }],
    action: { id: 'delivery-action', idempotencyKey: 'step:1', requester: 'owner', subject: 'host-delivery', target: { id: 'commitment', revision: 1 }, epoch: 1,
      mandateRef: { id: 'mandate', revision: 1 }, capabilityRef: { id: 'capability', revision: 1 }, workspaceId: 'workspace', resourceIds: ['repository:' + realpathSync(join(root, '.git')), 'branch:' + realpathSync(join(root, '.git')) + ':dev'], scopeRefs: [], purpose: 'engineering' as const, timeoutMs: 10000, processPolicy: 'single' as const },
  }
  const step = planLocalGitDelivery(input, storage)
  const acceptance: DeliveryAcceptance = { ref: step.acceptanceRef, candidateRef: { id: 'candidate', revision: 1 }, evaluationRef: { id: 'evaluation', revision: 1 }, finalTree: step.finalTree, manifestDigest: manifestDigest(step), gateRefs: step.requiredGateRefs }
  let current = acceptance
  const envelope: ExecutionEnvelope = { kind: 'envelope', actionRef: { id: 'delivery-action', revision: 1 }, target: step.action.target, epoch: 1, expiresAt: Date.now() + 60000,
    workspace: { id: 'workspace', root, source: root, repositoryId: step.realGitDir, baseline: step.expectedParent, branch: 'dev', resources: step.action.resourceIds, sourceStatus: '', role: 'engineering' }, spec: prepareDeliveryStep(step) }
  const port = createLocalGitDelivery({ storageRoot: storage, readAcceptance: () => current, fence: () => envelope })
  return { root, candidate, storage, step, envelope, port, setAcceptance: (value: DeliveryAcceptance) => { current = value } }
}
describe('P7 real local Git delivery', () => {
  it('refuses absent/stale final-tree evidence and never equates text with delivery', async () => {
    const f = fixture(); f.setAcceptance({} as DeliveryAcceptance)
    await expect(f.port.executeLocalGitDelivery(f.step, f.envelope)).rejects.toThrow('DELIVERY_ACCEPTANCE')
    expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(f.step.expectedParent)
    expect(f.port.verifyDeliveryReceipt(f.step.ref, { text: 'completed; all tests passed' } as never).verdict).toBe('fail')
  })
  it('publishes exact tree/modes, aligns owned files/index, and preserves unrelated staged hunks/flags/dirty content', async () => {
    const f = fixture(), staged = git(f.root, ['ls-files', '-s', 'user.txt']), flags = git(f.root, ['ls-files', '-v', 'flags.txt'])
    const receipt = await f.port.executeLocalGitDelivery(f.step, f.envelope)
    expect(receipt.commit).toBe(f.step.plannedCommit)
    expect(git(f.root, ['rev-parse', 'HEAD^{tree}'])).toBe(f.step.finalTree)
    expect(readFileSync(join(f.root, 'fix.txt'), 'utf8')).toBe('fixed\n')
    expect(file(f.root, 'fix.txt')!.mode).toBe('100755')
    expect(git(f.root, ['diff', '--cached', '--', 'fix.txt'])).toBe('')
    expect(git(f.root, ['diff', '--', 'fix.txt'])).toBe('')
    expect(git(f.root, ['ls-files', '-s', 'user.txt'])).toBe(staged)
    expect(git(f.root, ['ls-files', '-v', 'flags.txt'])).toBe(flags)
    expect(readFileSync(join(f.root, 'user.txt'), 'utf8')).toBe('unstaged user\n')
    expect(f.port.verifyDeliveryReceipt(f.step.ref, receipt).verdict).toBe('pass')
  })
  it('rejects candidate/mode mutation and advanced dev without publishing', async () => {
    const f = fixture(); chmodSync(join(f.candidate, 'fix.txt'), 0o644)
    await expect(f.port.executeLocalGitDelivery(f.step, f.envelope)).rejects.toThrow('DELIVERY_CANDIDATE_CHANGED')
    chmodSync(join(f.candidate, 'fix.txt'), 0o755)
    git(f.root, ['commit', '--allow-empty', '-m', 'concurrent user commit'])
    const head = git(f.root, ['rev-parse', 'HEAD'])
    await expect(f.port.executeLocalGitDelivery(f.step, f.envelope)).rejects.toThrow('DELIVERY_HEAD_CHANGED')
    expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(head)
  })
  it('reconciles publication with lost receipt and a partial worktree without duplicating commit', async () => {
    const f = fixture(); let crash = true
    const port = createLocalGitDelivery({ storageRoot: f.storage, readAcceptance: () => ({ ref: f.step.acceptanceRef, candidateRef: { id: 'candidate', revision: 1 }, evaluationRef: { id: 'evaluation', revision: 1 }, finalTree: f.step.finalTree, manifestDigest: manifestDigest(f.step), gateRefs: f.step.requiredGateRefs }), fence: () => f.envelope,
      checkpoint: stage => { if (stage === 'published' && crash) { crash = false; throw new Error('simulated lost receipt') } } })
    await expect(port.executeLocalGitDelivery(f.step, f.envelope)).rejects.toThrow('simulated lost receipt')
    expect(git(f.root, ['rev-parse', 'HEAD'])).toBe(f.step.plannedCommit)
    const receipt = await f.port.executeLocalGitDelivery(f.step, f.envelope)
    expect(receipt.stage).toBe('aligned'); expect(git(f.root, ['rev-list', '--count', 'HEAD'])).toBe('2')
    expect(await f.port.executeLocalGitDelivery(f.step, f.envelope)).toEqual(receipt)
  })
  it('preserves a concurrent user edit during reconciliation', async () => {
    const f = fixture()
    const port = createLocalGitDelivery({ storageRoot: f.storage, readAcceptance: () => ({ ref: f.step.acceptanceRef, candidateRef: { id: 'candidate', revision: 1 }, evaluationRef: { id: 'evaluation', revision: 1 }, finalTree: f.step.finalTree, manifestDigest: manifestDigest(f.step), gateRefs: f.step.requiredGateRefs }), fence: () => f.envelope, checkpoint: stage => { if (stage === 'published') throw new Error('crash') } })
    await expect(port.executeLocalGitDelivery(f.step, f.envelope)).rejects.toThrow('crash')
    writeFileSync(join(f.root, 'fix.txt'), 'user new work\n')
    await expect(f.port.executeLocalGitDelivery(f.step, f.envelope)).rejects.toThrow('DELIVERY_WORKTREE_CHANGED')
    expect(readFileSync(join(f.root, 'fix.txt'), 'utf8')).toBe('user new work\n')
    expect(git(f.root, ['rev-list', '--count', 'HEAD'])).toBe('2')
  })
})

import { createOutletPolicy } from '../src/host/services/superagent/timing/outlet-policy.ts'
import { momentAllowed } from '../src/host/services/superagent/surface/moment.ts'
import { createDeliveryFulfillment } from '../src/host/services/superagent/kernel/delivery-ledger.ts'
import { ManagedLedger } from '../src/host/services/superagent/kernel/managed-ledger.ts'

describe('P7 evidence-bound reporting and fulfillment', () => {
  const facts = { committedInThisTurn: true, commitmentTerminal: true, dispositionAnswersInbound: true, hasAskedAssumptionOrRoute: true, brokenOrAtRiskOrDispatchFailed: false, isAgendaTurnWithSignal: false, byPushbackTool: false, byHost: false }
  it('terminal/closed state is not a delivery proof', () => {
    expect(momentAllowed('deliver', facts)).toBe(false)
  })
  it('never passes arbitrary completion prose in answer/ask/ack, while progress and clarification remain usable', () => {
    const policy = createOutletPolicy({
      attentionCtx: () => ({ moment: 'answer', ballToOwnerWithClock: false, irreversible: false, isReplyToInbound: true, interruptsToday: 0, quotaPerDay: 5, localHHMM: '12:00', quiet: { from: '23:00', to: '07:00' } } as never),
      momentFacts: () => facts, workReport: () => ({ state: 'unverified', commitmentId: 'C-1' }), disclosures: () => [], mayPromise: () => true, identityNeeded: () => false, ownerLabel: () => 'Owner',
    })
    for (const moment of ['answer', 'ask', 'ack'] as const) {
      const verdict = policy.check({ chat_id: 'chat', moment, payload: 'text', audience: 'owner', text: 'Everything completed and all tests passed. 已全部完成。', idem_key: 'sa:ack:spoof' }, Date.now())
      expect(verdict.ok).toBe(true)
      if (verdict.ok) { expect(verdict.text).not.toContain('Everything'); expect(verdict.text).not.toContain('已全部完成') }
    }
  })
  it('generic commands and forged host tokens cannot fulfill', () => {
    const f = fixture(), ledger = new ManagedLedger(join(f.storage, 'ledger.sqlite'))
    try {
      expect(() => ledger.delivery({ token: {}, source: { id: 'host', revision: 1 }, step: f.step, receipt: {} as never })).toThrow('DELIVERY_HOST_REQUIRED')
      const fulfill = createDeliveryFulfillment(ledger, { id: 'host', revision: 1 }, () => { throw new Error('DELIVERY_ACCEPTANCE_REQUIRED') })
      expect(() => fulfill(f.step, {} as never)).toThrow()
      expect(() => ledger.transact([], [{ kind: 'fulfill', id: 'commitment' }])).toThrow('PHASE_NOT_IMPLEMENTED')
    } finally { ledger.close() }
  })
})

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { verificationFixture, verificationCleanup } from './fixtures/superagent/verification.ts'
import { sealProjectInputs } from '../src/host/services/superagent/executors/project-snapshot.ts'
import { readDeliveryAcceptance, type DeliveryAcceptanceBinding } from '../src/host/services/superagent/verification/delivery-acceptance.ts'
import { createManagedLocalDelivery } from '../src/host/services/superagent/index.ts'
import { verifyWorkspace } from '../src/host/services/superagent/kernel/resources.ts'
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
afterEach(() => { for (const clean of verificationCleanup.splice(0)) clean() })
it('real controlled host delivery requires complete canonical acceptance, then fulfills once; stale gates and revocation refuse', async () => {
  const f = fixture(), v = verificationFixture()
  const object = (id: string, kind: string, data: Record<string, unknown>, scope_revision_refs: { id: string; revision: number }[] = []) => ({ id, kind, revision: 1, data, scope_revision_refs, extensions: {} })
  const contractRef = { id: 'delivery-contract', revision: 1 }
  v.ledger.transact([], [{ kind: 'create', object: object(contractRef.id, 'delivery_contract', { intent: 'exact local dev commit', requirement_refs: [{ id: 'requirement', revision: 1 }], step_refs: [f.step.ref], source_refs: [{ id: 'human', revision: 1 }] }, [{ id: 'requirement', revision: 1 }]) as never }])
  const original = v.ledger.get('commitment')!
  delete original.data.state_reason
  v.ledger.transact([], [{ kind: 'create', object: { ...original, id: 'delivery-work', revision: 1, data: { ...original.data, state: 'proposed', delivery_contract: contractRef }, scope_revision_refs: [...original.scope_revision_refs, contractRef] } }])
  for (const state of ['ready', 'working'] as const) { const c = v.ledger.get('delivery-work')!; v.ledger.transact([{ id: c.id, revision: c.revision }], [{ kind: 'transition', id: c.id, state, reason: 'fixture authorization' }]) }
  const assignment = v.service.registerAssignment({ commitmentId: 'delivery-work', contract: { id: 'contract', revision: 1 }, requirements: [{ id: 'requirement', revision: 1 }], generators: ['engineer'], reviewer: 'qa' })
  const candidate = v.service.collectCandidate(assignment, { sourceRoot: v.source, entry: 'candidate.mjs', exportName: 'inspect', environment: 'fixture' })
  const context = await v.service.sealVerificationContext({ candidate, qualification: v.qualification, cases: [{ criterion: 'requirement', input: 'expected', expected: 'expected' }] })
  const evidence = await v.run(context), evaluation = v.service.assessCandidate({ id: 'contract', revision: 1 }, candidate, [evidence])
  const c = v.ledger.get('delivery-work')!, target = v.service.enterDelivery({ id: c.id, revision: c.revision }, evaluation)
  const names = ['typecheck', 'test', 'docs:check', 'build', 'test:scripts', 'runtime-deps:check', 'sync-shared:check']
  // These are tiny fixture project commands, not the dsh-cove gates or M1 qualification.
  const command = `node -e "import('./candidate.mjs').then(m=>{if(m.inspect('expected')!=='expected')process.exit(1);console.log('fixture project gate passed')})"`
  writeFileSync(join(f.candidate, 'candidate.mjs'), readFileSync(join(v.source, 'candidate.mjs')))
  writeFileSync(join(f.candidate, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: Object.fromEntries(names.map(name => [name, command])) }))
  writeFileSync(join(f.candidate, 'user.txt'), 'original\n'); writeFileSync(join(f.candidate, 'flags.txt'), 'flags\n')
  const manifest = ['fix.txt', 'candidate.mjs', 'package.json'].map(path => { const entry = file(f.candidate, path)!; return { path, blob: entry.blob, mode: entry.mode } })
  const workspace = { ...f.envelope.workspace, id: 'delivery-workspace' }
  v.kernel.host.registerWorkspace(workspace)
  const expiry = Date.now() + 60000, control = v.kernel.host.grantControl(target, 'host-delivery', expiry)
  const step = planLocalGitDelivery({ ...f.step, manifest, action: { ...f.step.action, target, epoch: control.epoch, workspaceId: workspace.id, scopeRefs: v.service.requiredActionScopes(target.id) }, requiredGateRefs: names.map(id => ({ id: 'gate:' + id, revision: 1 })) }, f.storage)
  const seal = sealProjectInputs({ sourceRoot: f.candidate, sourceFiles: ['fix.txt', 'candidate.mjs', 'package.json', 'user.txt', 'flags.txt'], dependencyRoots: [], tools: [], destination: join(f.storage, 'source-seal'), provenance: { source: 'isolated-real-git-fixture', revision: step.expectedParent } })
  const binding: DeliveryAcceptanceBinding = { ref: step.acceptanceRef, candidate, evaluation, seal, authorizationVersion: 'fixture-v1', gates: [] }
  const fixtureCapability = process.env.DSH_P7_KEEPER_FIXTURE
  const ownedFixture = fixtureCapability ? undefined : await createProjectKeeperFixture({runId:'p7-direct-'+Date.now(),epoch:1,expiresAt:Date.now()+60000})
  const capabilityPath = fixtureCapability ?? ownedFixture!.capabilityPath
  if(ownedFixture)keeperClosers.push(ownedFixture.close)
  const keeper=readKeeperFixtureCapability(capabilityPath).ref,keeperRef={instance:keeper.instance,root:keeper.root,pid:keeper.pid,artifactDigest:keeper.artifactDigest}
  for (const wrong of ['runId','epoch','assetSha','pid'] as const) {
    const cap=readKeeperFixtureCapability(capabilityPath), altered=structuredClone(cap)
    if(wrong==='pid')altered.ref={...altered.ref,pid:altered.ref.pid+1}
    else if(wrong==='epoch')altered.epoch+=1
    else if(wrong==='assetSha'){altered.assetSha='0'.repeat(64);altered.ref={...altered.ref,artifactDigest:altered.assetSha}}
    else altered.runId+='-foreign'
    const path=join(f.storage,'wrong-'+wrong+'.json');writeFileSync(path,JSON.stringify(altered),{mode:0o400})
    await expect(keeperFixtureRequest(path,'pause',altered.ref)).rejects.toThrow('P7_FIXTURE_SCOPE')
    expect((await keeperFixtureRequest(capabilityPath,'current',keeperRef)).current).toBe(true)
  }
  const priorCapability=process.env.DSH_P7_KEEPER_FIXTURE
  process.env.DSH_P7_KEEPER_FIXTURE=capabilityPath
  keeperClosers.push(async()=>{if(priorCapability)process.env.DSH_P7_KEEPER_FIXTURE=priorCapability;else delete process.env.DSH_P7_KEEPER_FIXTURE})
  for (const [index, gate] of names.entries()) {
    const stdout = execFileSync('pnpm', [gate], { cwd: f.candidate, encoding: 'utf8', env: process.env }), outPath = join(f.storage, gate.replace(':', '-') + '.out'), errPath = outPath + '.err'
    writeFileSync(outPath, stdout); writeFileSync(errPath, '')
    const exit = { observed: true, code: 0, signal: null }, result = { gate, command: ['pnpm', gate], complete: true, exit, errors: [], stdout: { path: outPath, sha256: sha(stdout) }, stderr: { path: errPath, sha256: sha('') } }
    const observation = JSON.stringify({ keeperRef, gate, sourceDigest: seal.digest, authorizationVersion: 'fixture-v1', planVersion: 'project-gates-v2', complete: true, isolationCurrent: true, exit, errors: [], plan: [gate], steps: [result] }), path = outPath + '.json'
    writeFileSync(path, observation)
    binding.gates.push({ ref: step.requiredGateRefs[index]!, gate, observationPath: path, observationDigest: sha(observation) })
  }
  expect(() => readDeliveryAcceptance(v.ledger, step, { ...binding, gates: binding.gates.slice(1) })).toThrow('DELIVERY_ACCEPTANCE_GATES')
  const rawPath = JSON.parse(readFileSync(binding.gates[0]!.observationPath, 'utf8')).steps[0].stdout.path as string
  const raw = readFileSync(rawPath); writeFileSync(rawPath, 'tampered collector output')
  expect(() => readDeliveryAcceptance(v.ledger, step, binding)).toThrow('DELIVERY_GATE_RAW_CHANGED')
  writeFileSync(rawPath, raw)
  const byteOnly = structuredClone(binding)
  delete (byteOnly.seal.manifest[0] as { executable?: boolean }).executable
  expect(() => readDeliveryAcceptance(v.ledger, step, byteOnly)).toThrow('DELIVERY_ACCEPTANCE_SEAL')
  const launch = prepareDeliveryStep(step)
  v.kernel.host.grantCapability({ id: step.action.capabilityRef.id, revision: 1, expiresAt: expiry, scopeRefs: step.action.scopeRefs, evidenceRefs: ['fixture-complete-acceptance'], externalTools: 'blocked', revoked: false, launch: { executable: launch.executable, args: [], processPolicy: 'single' }, expectedDevTransition: launch.expectedDevTransition })
  v.kernel.host.grantMandate({ id: step.action.mandateRef.id, revision: 1, requester: 'owner', subject: 'host-delivery', target, workspaceId: workspace.id, resourceIds: workspace.resources, actions: ['deliver'], scopeRefs: step.action.scopeRefs, expiresAt: expiry, revoked: false })
  const action = v.kernel.actions.planAction(launch); v.kernel.actions.claimResources(action.ref, workspace.resources)
  const service = createManagedLocalDelivery({ ledger: v.ledger, source: { id: 'host', revision: 1 }, storageRoot: f.storage, host: v.kernel.host, binding: () => binding })
  const receipt = await service.execute(step, action.ref)
  expect(() => verifyWorkspace(workspace)).toThrow('WORKSPACE_IDENTITY_CHANGED')
  expect(service.verifyDeliveryReceipt(step.ref, receipt).verdict).toBe('pass')
  if (process.env.DSH_P7_PROOF_PATH) writeFileSync(process.env.DSH_P7_PROOF_PATH, JSON.stringify({ receipt, head: git(f.root, ['rev-parse', 'HEAD']), tree: git(f.root, ['rev-parse', 'HEAD^{tree}']), commitCount: git(f.root, ['rev-list', '--count', 'HEAD']), ownedStagedDiff: git(f.root, ['diff', '--cached', '--', ...step.manifest.map(x => x.path)]), ownedWorktreeDiff: git(f.root, ['diff', '--', ...step.manifest.map(x => x.path)]), preservedUserStage: git(f.root, ['show', ':user.txt']), preservedUserWorktree: readFileSync(join(f.root, 'user.txt'), 'utf8'), preservedFlags: git(f.root, ['ls-files', '-v', 'flags.txt']), evaluation: service.verifyDeliveryReceipt(step.ref, receipt) }, null, 2))
  const fulfilled = service.fulfill(step, receipt)
  expect(v.ledger.get(fulfilled.id)?.data.state).toBe('fulfilled')
  expect(service.report(step.ref, receipt)).toContain(receipt.commit)
  expect(service.report(step.ref, receipt)).toContain('未推送，未上线')
  expect(service.fulfill(step, receipt)).toEqual(fulfilled)
  expect(await service.execute(step, receipt.actionRef)).toEqual(receipt)
  // A formerly passing gate cannot outlive its retained isolation holder.
  await keeperFixtureRequest(capabilityPath,'pause',keeperRef)
  try {
    expect(service.verifyDeliveryReceipt(step.ref, receipt).verdict).toBe('fail')
    expect(() => service.report(step.ref, receipt)).toThrow()
    expect(() => service.fulfill(step, receipt)).toThrow('DELIVERY_GATE_KEEPER_NOT_CURRENT')
    await expect(service.execute(step, receipt.actionRef)).rejects.toThrow('DELIVERY_GATE_KEEPER_NOT_CURRENT')
  } finally { await keeperFixtureRequest(capabilityPath,'resume',keeperRef) }
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(service.verifyDeliveryReceipt(step.ref, receipt).verdict).toBe('pass')
  const parentReq = { ...v.ledger.get('requirement')!, id: 'parent-requirement', data: { ...v.ledger.get('requirement')!.data, intent: 'full M1 outcome', observable_results: ['full M1 outcome'] } }
  const parentContract = object('parent-contract', 'acceptance_contract', { intent: 'parent acceptance', requirement_refs: [{ id: parentReq.id, revision: 1 }], criterion_refs: [{ id: parentReq.id, revision: 1 }], source_refs: [{ id: 'human', revision: 1 }] }, [{ id: parentReq.id, revision: 1 }])
  const parent = { ...original, id: 'parent-M1', revision: 1, data: { ...original.data, state: 'proposed', requirement_refs: [{ id: parentReq.id, revision: 1 }], acceptance_contract: { id: parentContract.id, revision: 1 } }, scope_revision_refs: [{ id: parentReq.id, revision: 1 }, { id: parentContract.id, revision: 1 }] }
  const child = { ...original, id: 'uncovered-api', revision: 1, data: { ...original.data, state: 'proposed', parent_id: parent.id, delivery_contract: contractRef }, scope_revision_refs: [...original.scope_revision_refs, contractRef, { id: parent.id, revision: 1 }] }
  v.ledger.transact([], [parentReq, parentContract, parent, child].map(o => ({ kind: 'create', object: o })) as never)
  for (const state of ['ready', 'working'] as const) { const current = v.ledger.get(child.id)!; v.ledger.transact([{ id: current.id, revision: current.revision }], [{ kind: 'transition', id: current.id, state, reason: 'fixture child work' }]) }
  const childAssignment = v.service.registerAssignment({ commitmentId: child.id, contract: { id: 'contract', revision: 1 }, requirements: [{ id: 'requirement', revision: 1 }], generators: ['engineer'], reviewer: 'qa' })
  const childCandidate = v.service.collectCandidate(childAssignment, { sourceRoot: v.source, entry: 'candidate.mjs', exportName: 'inspect', environment: 'fixture' })
  const childContext = await v.service.sealVerificationContext({ candidate: childCandidate, qualification: v.qualification, cases: [{ criterion: 'requirement', input: 'expected', expected: 'expected' }] })
  const childEvidence = await v.run(childContext), childEvaluation = v.service.assessCandidate({ id: 'contract', revision: 1 }, childCandidate, [childEvidence])
  const currentChild = v.ledger.get(child.id)!, childTarget = v.service.enterDelivery({ id: child.id, revision: currentChild.revision }, childEvaluation)
  expect(() => readDeliveryAcceptance(v.ledger, { ...step, action: { ...step.action, target: childTarget } }, { ...binding, candidate: childCandidate, evaluation: childEvaluation })).toThrow('DELIVERY_PARENT_COVERAGE_REQUIRED')
  v.service.revokeQualification(v.qualification, { reviewer: 'qa', reason: 'fixture method revoked', evidenceRefs: ['new calibration failure'] })
  expect(service.verifyDeliveryReceipt(step.ref, receipt).verdict).toBe('fail')
  expect(() => service.report(step.ref, receipt)).toThrow()
  expect(() => service.fulfill(step, receipt)).toThrow()
}, 30000)

import { renderWorkReport } from '../src/host/services/superagent/surface/templates.ts'
it('renders a concrete canonical question and observed execution progress without invented success', () => {
  const question = renderWorkReport('ask', 'working', undefined, 'C-1', { question: { ref: 'C-1:assumption:1', text: '旧 API 返回字段要保留还是移除？' } })
  expect(question).toContain('旧 API 返回字段要保留还是移除？')
  expect(question).toContain('C-1:assumption:1')
  const progress = renderWorkReport('answer', 'working', undefined, 'C-1', { progress: { ref: 'C-1:A1', state: 'running', toolCalls: 4 } })
  expect(progress).toContain('C-1:A1'); expect(progress).toContain('4 次工具调用'); expect(progress).toContain('尚无完整验收')
})
