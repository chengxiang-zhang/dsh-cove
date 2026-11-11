import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import type { ManagedLedger } from '../kernel/managed-ledger.ts'
import { createVerificationWriter, verificationScopes } from '../kernel/verification-ledger.ts'
import { assertJson, type Ref, type Json } from '../protocol/managed-work.ts'
import type {
  AssignmentInput,
  CandidateInput,
  QualificationInput,
  VerificationCase,
  ReviewContextInput
} from '../protocol/verification.ts'
import {
  prepareVerificationAssets,
  collectVerification,
  verificationProcessLaunch,
  verificationRuntimeDigest
} from '../executors/verification-run.ts'
import { CANDIDATE_PROGRAM } from '../executors/verification-programs.ts'
import { snapshotVerificationSource } from '../executors/verification-snapshot.ts'
import type { createControlledKernel, ActionReceipt } from '../kernel/actions.ts'

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown): Json => {
  assertJson(value)
  return value
}

/** Composition-only service. Its writer and collector are never exposed as model tools. */
export function createVerificationService(ledger: ManagedLedger, source: Ref, storageRoot: string) {
  mkdirSync(storageRoot, { recursive: true, mode: 0o700 })
  const storage = realpathSync(storageRoot)
  const write = createVerificationWriter(ledger, source)
  const get = (r: Ref, kind: string) => {
    const o = ledger.get(r.id)
    if (
      !o ||
      o.revision !== r.revision ||
      o.kind !== kind ||
      ledger.applicability(r.id) !== 'usable'
    )
      throw new Error('VERIFICATION_STALE_REFERENCE')
    return o
  }
  const service = {
    registerAssignment: (input: AssignmentInput) => write({ kind: 'assignment', input }),
    grantQualification: (input: QualificationInput) =>
      write({ kind: 'qualification', input, runtimeDigest: verificationRuntimeDigest() }),
    collectCandidate(assignment: Ref, input: CandidateInput): Ref {
      get(assignment, 'verification_assignment')
      const sourceRoot = realpathSync(input.sourceRoot)
      if (
        !relative(sourceRoot, storage).startsWith('..') ||
        isAbsolute(input.entry) ||
        input.entry.split(/[\\/]/).includes('..') ||
        !input.exportName.trim() ||
        !input.environment.trim()
      )
        throw new Error('CANDIDATE_PATH_SCOPE')
      const root = mkdtempSync(join(storage, 'candidate-'))
      const manifest = snapshotVerificationSource(sourceRoot, root)
      if (!manifest.some((m) => m.path === input.entry)) throw new Error('CANDIDATE_ENTRY_MISSING')
      return write({
        kind: 'candidate',
        assignment,
        data: {
          root,
          digest: hash(JSON.stringify(manifest)),
          entry: input.entry,
          export_name: input.exportName,
          environment: input.environment,
          manifest: json(manifest)
        }
      })
    },
    async sealVerificationContext(input: {
      candidate: Ref
      qualification: Ref
      cases: VerificationCase[]
      review?: ReviewContextInput
    }): Promise<Ref> {
      const c = get(input.candidate, 'candidate'),
        a = get(c.data.assignment_ref as unknown as Ref, 'verification_assignment')
      get(input.qualification, 'qualification')
      const contract = get(a.data.contract_ref as unknown as Ref, 'acceptance_contract')
      const criteria = (contract.data.criterion_refs as unknown as Ref[]).map((r) => r.id)
      assertJson(input.cases)
      if (
        !input.cases.length ||
        Buffer.byteLength(JSON.stringify(input.cases)) > 1048576 ||
        input.cases.some(
          (v) =>
            !criteria.includes(v.criterion) ||
            !Object.hasOwn(v, 'input') ||
            !Object.hasOwn(v, 'expected') ||
            Object.keys(v).some((k) => !['criterion', 'input', 'expected'].includes(k))
        ) ||
        criteria.some((id) => !input.cases.some((v) => v.criterion === id))
      )
        throw new Error('CRITERION_COVERAGE_REQUIRED')
      const assetRoot = mkdtempSync(join(storage, 'assets-'))
      const assets = join(assetRoot, 'cases.json')
      const preparerPid = await prepareVerificationAssets(assets, input.cases)
      const frozenCases = JSON.parse(readFileSync(assets, 'utf8')) as VerificationCase[]
      const reviewIssue = input.review ? get(input.review.issue, 'review_issue') : undefined
      return write({
        kind: 'context',
        candidate: input.candidate,
        qualification: input.qualification,
        data: {
          run_id: randomUUID(),
          asset_root: assetRoot,
          asset_digest: hash(readFileSync(assets)),
          criteria,
          collector_version: 'offline-json-v1',
          runtime_digest: verificationRuntimeDigest(),
          preparer_pid: preparerPid,
          case_bindings: json(
            frozenCases.map((test) => ({
              criterion: test.criterion,
              digest: hash(JSON.stringify(test))
            }))
          ),
          review_binding: input.review
            ? json({
                issue_ref: input.review.issue,
                purpose: input.review.purpose,
                release_condition: reviewIssue!.data.release_condition,
                coverage_basis: input.review.coverageBasis
              })
            : null
        }
      })
    },
    processLaunch: verificationProcessLaunch,
    requiredActionScopes: (commitmentId: string) => verificationScopes(ledger, commitmentId),
    async run(
      context: Ref,
      execution: { host: ReturnType<typeof createControlledKernel>['host']; action: Ref }
    ): Promise<Ref> {
      const ctx = get(context, 'verification_context'),
        c = get(ctx.data.candidate_ref as unknown as Ref, 'candidate')
      if (!execution?.host) throw new Error('VERIFICATION_ACTION_REQUIRED')
      if (ctx.data.runtime_digest !== verificationRuntimeDigest())
        throw new Error('VERIFICATION_ENVIRONMENT_CHANGED')
      const envelope = execution.host.beginDispatch(execution.action)
      if (envelope.kind !== 'envelope') throw new Error('VERIFICATION_EXECUTION_FENCED')
      let receipt: ActionReceipt = {
        status: 'failed',
        stopped: true,
        evidenceRefs: ['verification-preflight:' + String(ctx.data.run_id)],
        reason: 'VERIFICATION_PREPARATION_FAILED'
      }
      try {
        const sealed = verificationProcessLaunch()
        if (
          envelope.spec.kind !== 'collect' ||
          envelope.spec.purpose !== 'collector' ||
          envelope.spec.executable !== sealed.executable ||
          JSON.stringify(envelope.spec.args) !== JSON.stringify(sealed.args) ||
          envelope.nativeRuntime ||
          envelope.spec.processPolicy !== 'single' ||
          !envelope.spec.scopeRefs.some(
            (r) => r.id === context.id && r.revision === context.revision
          )
        )
          throw new Error('VERIFICATION_ACTION_REQUIRED')
        write({ kind: 'begin_run', context, action: envelope.actionRef })
        const scratch = mkdtempSync(join(envelope.workspace.root, 'execution-')),
          runtime = mkdtempSync(join(storage, 'runtime-'))
        const wrapper = join(runtime, 'candidate.mjs')
        writeFileSync(wrapper, CANDIDATE_PROGRAM, { flag: 'wx', mode: 0o400 })
        receipt = {
          status: 'unknown',
          stopped: false,
          evidenceRefs: [],
          reason: 'VERIFICATION_OBSERVATION_LOST'
        }
        const result = await collectVerification(
          {
            root: String(c.data.root),
            entry: String(c.data.entry),
            exportName: String(c.data.export_name),
            assets: join(String(ctx.data.asset_root), 'cases.json'),
            assetDigest: String(ctx.data.asset_digest),
            manifest: c.data.manifest as unknown as { path: string; digest: string }[],
            runId: String(ctx.data.run_id),
            scratch,
            wrapper,
            timeoutMs: Math.min(
              3000,
              envelope.spec.timeoutMs,
              Math.max(1, envelope.expiresAt - Date.now())
            )
          },
          () => execution.host.fenceDispatch(envelope.actionRef).kind === 'envelope'
        )
        const stopped = result.observation.exit_code !== null
        receipt = {
          status: stopped ? (result.observation.complete ? 'confirmed' : 'failed') : 'unknown',
          stopped,
          evidenceRefs: ['collector:' + result.digest],
          ...(stopped ? { exitCode: result.observation.exit_code! } : {}),
          observation: {
            stdout: result.observation.stdout,
            stderr: result.observation.stderr,
            observedAt: Date.now()
          }
        }
        return write({
          kind: 'evidence',
          context,
          observation: result.observation,
          digest: result.digest
        })
      } finally {
        execution.host.reconcileAction(envelope.actionRef, receipt)
      }
    },
    assessCandidate: (contract: Ref, candidate: Ref, evidence: Ref[]) =>
      write({ kind: 'assess', contract, candidate, evidence }),
    recordReviewIssue: (input: {
      candidate: Ref
      criterion: string
      source: string
      reproductionRefs: Ref[]
      impact: string
      responsible: string
      releaseCondition: string
    }) => write({ kind: 'issue', ...input }),
    resolveReviewIssue: (issue: Ref, evaluation: Ref) =>
      write({ kind: 'resolve', issue, evaluation }),
    advanceReviewIssue: (issue: Ref, state: 'addressing' | 'awaiting_recheck') =>
      write({ kind: 'issue_progress', issue, state }),
    dismissReviewIssue: (issue: Ref, evaluation: Ref, basis: string) =>
      write({ kind: 'dismiss', issue, evaluation, basis }),
    revokeQualification: (
      qualification: Ref,
      decision: { reason: string; evidenceRefs: string[]; reviewer: string }
    ) => write({ kind: 'revoke', qualification, ...decision }),
    scanQualificationImpacts: (revocation: Ref, limit = 50) =>
      write({ kind: 'scan', revocation, limit }),
    enterDelivery: (commitment: Ref, evaluation: Ref) =>
      write({ kind: 'enter_delivery', commitment, evaluation }),
    recordDelivery: (evaluation: Ref, action: Ref) =>
      write({ kind: 'delivery', evaluation, action }),
    affectedByQualification(qualification: Ref) {
      const revocations = new Set(
        ledger
          .snapshot()
          .filter(
            (o) =>
              o.kind === 'qualification_revocation' &&
              (o.data.qualification_ref as unknown as Ref).id === qualification.id
          )
          .map((o) => o.id)
      )
      return ledger
        .snapshot()
        .filter(
          (o) =>
            o.kind === 'qualification_impact' &&
            revocations.has((o.data.revocation_ref as unknown as Ref).id)
        )
    }
  }
  return Object.freeze(service)
}
