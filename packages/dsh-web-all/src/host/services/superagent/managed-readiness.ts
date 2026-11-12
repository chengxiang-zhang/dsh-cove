/** Composition-only fixed calibration: coordinates kernel, workspace and verifier; not an executor plugin. */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createControlledKernel } from './kernel/actions.ts'
import { prepareWorkspace } from './world/workspaces.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { verificationRuntimeDigest } from './executors/verification-run.ts'
import { managedVerificationMethod, methodAssetDigest } from './executors/managed-verification-method.ts'
import { createVerificationService } from './verification/index.ts'
import { ManagedLedger } from './kernel/managed-ledger.ts'

function calibrationFixture(code = 'export function inspect(value) { return value }', database = 'ledger.sqlite') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'managed-calibration-')))
  const source = join(root, 'source')
  mkdirSync(source)
  writeFileSync(join(source, 'candidate.mjs'), code)
  const ledger = new ManagedLedger(join(root, database))
  ledger.transact(
    [],
    [
      {
        kind: 'create',
        object: {
          id: 'requirement',
          kind: 'requirement',
          revision: 1,
          extensions: {},
          scope_revision_refs: [],
          data: {
            intent: 'return the required data',
            source_refs: [{ id: 'human', revision: 1 }],
            wish_refs: [],
            observable_results: ['required data'],
            constraints: [],
            criterion_sources: ['user']
          }
        }
      }
    ]
  )
  ledger.transact(
    [],
    [
      {
        kind: 'create',
        object: {
          id: 'contract',
          kind: 'acceptance_contract',
          revision: 1,
          extensions: {},
          scope_revision_refs: [{ id: 'requirement', revision: 1 }],
          data: {
            intent: 'independent comparison',
            requirement_refs: [{ id: 'requirement', revision: 1 }],
            criterion_refs: [{ id: 'requirement', revision: 1 }],
            source_refs: [{ id: 'human', revision: 1 }]
          }
        }
      }
    ]
  )
  ledger.transact(
    [],
    [
      {
        kind: 'create',
        object: {
          id: 'commitment',
          kind: 'commitment',
          revision: 1,
          extensions: {},
          scope_revision_refs: [
            { id: 'requirement', revision: 1 },
            { id: 'contract', revision: 1 }
          ],
          data: {
            intent: 'deliver',
            work_kind: 'task',
            type_ref: 'test/task@1',
            wish_refs: [],
            requirement_refs: [{ id: 'requirement', revision: 1 }],
            source_refs: [],
            project_refs: [],
            requirement_revision: 1,
            acceptance_contract: { id: 'contract', revision: 1 },
            delivery_contract: null,
            boundary: 'test',
            accountable: 'host',
            next_review_at: 1000,
            state: 'proposed',
            control_state: 'autonomous'
          }
        }
      }
    ]
  )
  for (const state of ['ready', 'working'] as const) {
    const c = ledger.get('commitment')!
    ledger.transact(
      [{ id: c.id, revision: c.revision }],
      [{ kind: 'transition', id: c.id, state, reason: 'authorized test work' }]
    )
  }
  const service = createVerificationService(
    ledger,
    { id: 'trusted-qa-host', revision: 1 },
    join(root, 'verification')
  )
  const qualification = service.grantQualification({
    method: 'json-equality@1',
    reviewer: 'qa',
    evidenceRefs: ['fixed-host-calibration-control-not-business-qualification'],
    expiresAt: Date.now() + 60000
  })
  const assignment = service.registerAssignment({
    commitmentId: 'commitment',
    contract: { id: 'contract', revision: 1 },
    requirements: [{ id: 'requirement', revision: 1 }],
    generators: ['engineer'],
    reviewer: 'qa'
  })
  const candidate = service.collectCandidate(assignment, {
    sourceRoot: source,
    entry: 'candidate.mjs',
    exportName: 'inspect',
    environment: 'node-local@1'
  })
  const seal = async (
    cases = [{ criterion: 'requirement', input: 'expected', expected: 'expected' }]
  ) => service.sealVerificationContext({ candidate, qualification, cases })
  const repo = join(root, 'collector-source'),
    provision = join(root, 'collector-workspaces')
  mkdirSync(repo)
  mkdirSync(provision)
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  git('init')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'test')
  writeFileSync(join(repo, 'asset'), 'collector workspace')
  git('add', '.')
  git('commit', '-m', 'baseline')
  const workspace = prepareWorkspace({
    source: repo,
    baseline: git('rev-parse', 'HEAD'),
    destination: join(provision, 'collector'),
    provisioningRoot: provision,
    role: 'collector'
  })
  const kernel = createControlledKernel(ledger, { id: 'host', revision: 1 })
  kernel.host.registerWorkspace(workspace)
  const admit = (context: { id: string; revision: number }) => {
    const id = randomUUID(),
      expiry = Date.now() + 60000,
      launch = service.processLaunch()
    kernel.host.grantCapability({
      id: 'cap-' + id,
      revision: 1,
      scopeRefs: [context],
      evidenceRefs: ['isolated-offline-json-method'],
      expiresAt: expiry,
      externalTools: 'blocked',
      revoked: false,
      launch
    })
    kernel.host.grantMandate({
      id: 'mandate-' + id,
      revision: 1,
      requester: 'owner',
      subject: 'qa',
      target: context,
      workspaceId: workspace.id,
      resourceIds: workspace.resources,
      actions: ['collect'],
      scopeRefs: [context],
      expiresAt: expiry,
      revoked: false
    })
    const control = kernel.host.grantControl(context, 'qa', expiry)
    const action = kernel.actions.planAction({
      id,
      idempotencyKey: id,
      requester: 'owner',
      subject: 'qa',
      target: context,
      epoch: control.epoch,
      mandateRef: { id: 'mandate-' + id, revision: 1 },
      capabilityRef: { id: 'cap-' + id, revision: 1 },
      kind: 'collect',
      workspaceId: workspace.id,
      resourceIds: workspace.resources,
      scopeRefs: [context],
      purpose: 'collector',
      ...launch,
      timeoutMs: 3000
    })
    kernel.actions.claimResources(action.ref, workspace.resources)
    return { host: kernel.host, action: action.ref }
  }
  const run = (context: { id: string; revision: number }) => service.run(context, admit(context))
  return {
    root,
    source,
    ledger,
    service,
    qualification,
    assignment,
    candidate,
    seal,
    run,
    admit,
    kernel,
    workspace
  }
}

// Captured when this module is evaluated, never read from disk by the endpoint.
const generation = randomUUID()
const loadedModuleDigest = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
export const managedLoadedIdentity = () => ({ generation, pid: process.pid, node: process.version, loadedModuleDigest, runtimeDigest: verificationRuntimeDigest() })
const calibrations = new Map<string, Promise<Awaited<ReturnType<typeof runCalibration>>>>()
export function calibrateManagedMethod(entryPath: string) {
  let pending = calibrations.get(entryPath)
  if (!pending) { pending = runCalibration(entryPath); calibrations.set(entryPath, pending) }
  return pending
}
async function runCalibration(entryPath: string) {
  const method = managedVerificationMethod('javascript-module@1', { entryPath })
  const controls: {label: string; input: import('./protocol/managed-work.ts').Json; expected: import('./protocol/managed-work.ts').Json; verdict: string}[] = [
    { label: 'known-good', input: { exportName: 'echo', args: [{ nested: [null, false, 3, 'x'] }] }, expected: { nested: [null, false, 3, 'x'] }, verdict: 'pass' },
    { label: 'exact-json-mismatch', input: { exportName: 'echo', args: [{a: 1}] }, expected: {a: 2}, verdict: 'fail' },
    { label: 'non-json-output', input: {exportName: 'invalid', args: []}, expected: null, verdict: 'inconclusive' },
    { label: 'own-alias-outside-denied', input: null, expected: {sameScratch: true, outsideDenied: true}, verdict: 'pass' },
  ]
  const results = []
  const observations = []
  for (const control of controls) {
    const f = calibrationFixture()
    try {
      const target = join(f.source, entryPath); mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, `import {realpathSync,readFileSync} from 'node:fs';
export async function echo(value) { await Promise.resolve(); return value }
export function invalid() { return undefined }
export function alias(outside) { const cwd=realpathSync(process.cwd()); const alias=cwd.replace(/^\\/private(?=\\/var(?:\\/|$))/,''); let denied=false; try {readFileSync(outside)} catch {denied=true} return {sameScratch:alias!==cwd&&realpathSync(alias)===cwd,outsideDenied:denied} }
`)
      for (const [path,bytes] of Object.entries(method.assets)) writeFileSync(join(f.source,path),bytes)
      const outside=join(f.root,'outside.txt');writeFileSync(outside,'synthetic outside control')
      const input=control.input??{exportName:'alias',args:[outside]}
      const candidate=f.service.collectCandidate(f.assignment,{sourceRoot:f.source,entry:method.entry,exportName:method.exportName,environment:'node-local@1'})
      const context=await f.service.sealVerificationContext({candidate,qualification:f.qualification,cases:[{criterion:'requirement',input,expected:control.expected}]})
      const evidence=await f.run(context), evaluation=f.service.assessCandidate({id:'contract',revision:1},candidate,[evidence])
      const observed=f.ledger.get(evidence.id)!, assessment=f.ledger.get(evaluation.id)!
      const record={label:control.label, expectedVerdict:control.verdict, verdict:assessment.data.verdict, collectorPid:observed.data.collector_pid, evidenceDigest:createHash('sha256').update(JSON.stringify(observed)).digest('hex')}
      results.push(record)
      observations.push({evidence:observed,evaluation:assessment})
      if(record.verdict!==control.verdict || !Number.isSafeInteger(record.collectorPid) || record.collectorPid===process.pid) throw Error('MANAGED_FIXED_CALIBRATION_FAILED:'+control.label)
    } finally {f.ledger.close();rmSync(f.root,{recursive:true,force:true})}
  }
  return { ...managedLoadedIdentity(), methodId:method.id, methodAssetsDigest:methodAssetDigest(JSON.stringify(method.assets)), results, observations, observedAt:Date.now() }
}
