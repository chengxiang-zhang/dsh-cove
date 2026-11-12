import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createControlledKernel } from '../../../src/host/services/superagent/kernel/actions.ts'
import { prepareWorkspace } from '../../../src/host/services/superagent/world/workspaces.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVerificationService } from '../../../src/host/services/superagent/verification/index.ts'
import { ManagedLedger } from '../../../src/host/services/superagent/kernel/managed-ledger.ts'
export const verificationCleanup: (() => void)[] = []
export function verificationFixture(code = 'export function inspect(value) { return value }', database = 'ledger.sqlite') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'p4-')))
  const source = join(root, 'source')
  mkdirSync(source)
  writeFileSync(join(source, 'candidate.mjs'), code)
  const ledger = new ManagedLedger(join(root, database))
  verificationCleanup.push(() => {
    ledger.close()
    rmSync(root, { recursive: true, force: true })
  })
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
    evidenceRefs: ['independent-calibration:good-bad-missing'],
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
