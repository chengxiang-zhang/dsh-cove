import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync, fsyncSync, realpathSync, chmodSync, lstatSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { DeliveryStep, DeliveryReceipt, DeliveryAcceptance, GitEntry } from '../../protocol/delivery.ts'
import type { ExecutionEnvelope } from '../../kernel/actions.ts'
import type { Ref } from '../../protocol/managed-work.ts'
import { deliveryActionSpec as prepareDeliveryStep, type DeliveryEvaluation } from '../../protocol/delivery.ts'
import { git, file, digest, identity, validateManifest, treeEntries, commitBytes, manifestDigest } from './git.ts'

const bytesDigest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const fingerprint = (root: string, path: string) => { const f = file(root, path); return f ? { blob: f.blob, mode: f.mode } : null }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
interface Journal {
  step: DeliveryStep
  stage: 'planned' | 'published' | 'worktree' | 'aligned'
  before: Record<string, { blob: string; mode: GitEntry['mode'] } | null>
  indexBefore: string
  indexAfter: string
  indexLockOwner: number
  indexLockIdentity: { dev: number; ino: number; markerDigest: string }
  receipt?: DeliveryReceipt
}
function durable(path: string, value: unknown): void {
  const temp = path + '.next'
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  const fd = openSync(temp, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temp, path)
  const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir) } finally { closeSync(dir) }
}
function writeEntries(root: string, index: string, s: Pick<DeliveryStep, 'manifest' | 'deletions'>): void {
  const lines = [...s.manifest.map(e => `${e.mode} ${e.blob}\t${e.path}\0`), ...s.deletions.map(p => `0 ${'0'.repeat(40)}\t${p}\0`)].join('')
  git(root, ['update-index', '-z', '--index-info'], lines, index)
}
/** Planning writes unreachable objects using a private index, never the main index or refs. */
export function planLocalGitDelivery(input: Omit<DeliveryStep, 'finalTree' | 'plannedCommit'>, storageRoot: string): DeliveryStep {
  identity(input as DeliveryStep); validateManifest(input as DeliveryStep)
  if (git(input.targetRoot, ['rev-parse', 'HEAD']) !== input.expectedParent) throw new Error('DELIVERY_HEAD_CHANGED')
  const scratch = mkdtempSync(join(storageRoot, 'plan-')), index = join(scratch, 'index')
  try {
    git(input.targetRoot, ['read-tree', input.expectedParent], undefined, index)
    for (const e of input.manifest) {
      const actual = file(input.candidateRoot, e.path)!
      if (git(input.targetRoot, ['hash-object', '-w', '--stdin'], actual.bytes) !== e.blob) throw new Error('DELIVERY_BLOB_CHANGED')
    }
    writeEntries(input.targetRoot, index, input)
    const finalTree = git(input.targetRoot, ['write-tree'], undefined, index)
    const plannedCommit = git(input.targetRoot, ['hash-object', '-t', 'commit', '-w', '--stdin'], commitBytes({ ...input, finalTree }))
    return { ...structuredClone(input), finalTree, plannedCommit }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
export interface LocalGitDeliveryDeps {
  storageRoot: string
  verifyReceipt(step: DeliveryStep, receipt: DeliveryReceipt): DeliveryEvaluation
  /** Trusted composition resolves current canonical evaluation, exact tree/modes and all required gate observations. */
  readAcceptance(step: DeliveryStep): DeliveryAcceptance
  /** Live controlled-kernel fence; this function is never exposed as model input. */
  fence(action: Ref): ExecutionEnvelope
  /** Host fault-injection/telemetry boundary, never supplied by a model. */
  checkpoint?(stage: Journal['stage']): void
}
export function assertDeliveryAcceptance(s: DeliveryStep, a: DeliveryAcceptance): void {
  if (!a || !same(a.ref, s.acceptanceRef) || !a.candidateRef?.id || !a.evaluationRef?.id || a.finalTree !== s.finalTree || a.manifestDigest !== manifestDigest(s) || !s.requiredGateRefs.length || !same(a.gateRefs, s.requiredGateRefs)) throw new Error('DELIVERY_ACCEPTANCE_REQUIRED')
}
/** Fixed host executor. It never runs candidate code, hooks, filters, a shell or remote Git. */
export function createLocalGitDelivery(deps: LocalGitDeliveryDeps) {
  mkdirSync(deps.storageRoot, { recursive: true, mode: 0o700 })
  const storage = realpathSync(deps.storageRoot)
  const journalPath = (r: Ref) => join(storage, digest(r) + '.json')
  const load = (r: Ref): Journal => JSON.parse(readFileSync(journalPath(r), 'utf8')) as Journal
  function live(s: DeliveryStep, envelope: ExecutionEnvelope): void {
    const current = deps.fence(envelope.actionRef)
    if (current.kind !== 'envelope' || current.expiresAt <= Date.now() || current.epoch !== envelope.epoch || !same(current.actionRef, envelope.actionRef) || !same(current.spec, prepareDeliveryStep(s)) || current.workspace.root !== s.targetRoot || current.workspace.baseline !== s.expectedParent || current.workspace.branch !== 'dev' || !['repository:' + s.realGitDir, 'branch:' + s.realGitDir + ':dev'].every(id => current.spec.resourceIds.includes(id)) || !same(envelope.spec, current.spec)) throw new Error('DELIVERY_EXECUTION_FENCED')
  }
  async function executeLocalGitDelivery(step: DeliveryStep, envelope: ExecutionEnvelope): Promise<DeliveryReceipt> {
    const s = structuredClone(step), path = journalPath(s.ref)
    identity(s)
    let journal = existsSync(path) ? load(s.ref) : undefined
    if (journal && !same(journal.step, s)) throw new Error('DELIVERY_STEP_CHANGED')
    const head = git(s.targetRoot, ['rev-parse', 'HEAD'])
    if (head !== s.expectedParent && head !== s.plannedCommit) throw new Error('DELIVERY_HEAD_CHANGED')
    if (head === s.plannedCommit && !journal) throw new Error('DELIVERY_PUBLICATION_UNOWNED')
    if (journal?.stage === 'aligned' && journal.receipt) {
      assertDeliveryAcceptance(s, deps.readAcceptance(s))
      const observed = deps.verifyReceipt(s, journal.receipt)
      if (observed.verdict !== 'pass') throw new Error('DELIVERY_RECONCILIATION_FAILED:' + observed.reason)
      return journal.receipt
    }
    // Reconciliation of an already published commit is historical; reauthorization is
    // needed for any further write, and stale acceptance cannot produce a passing report.
    live(s, envelope); assertDeliveryAcceptance(s, deps.readAcceptance(s)); validateManifest(s)
    const lock = join(s.realGitDir, 'index.lock'), deliveryLock = join(s.realGitDir, 'dsh-delivery.lock')
    if (existsSync(deliveryLock)) {
      const owner = JSON.parse(readFileSync(deliveryLock, 'utf8')) as { pid: number; step: Ref }
      let alive = true; try { process.kill(owner.pid, 0) } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH' }
      if (alive || !same(owner.step, s.ref)) throw new Error('DELIVERY_RESOURCE_BUSY')
      // Only reclaim this exact dead host's lock and recorded index bytes.
      if (existsSync(lock)) {
        const actual = bytesDigest(readFileSync(lock))
        const stat = lstatSync(lock)
        if (!journal || stat.dev !== journal.indexLockIdentity.dev || stat.ino !== journal.indexLockIdentity.ino || ![journal.indexAfter, journal.indexLockIdentity.markerDigest].includes(actual)) throw new Error('DELIVERY_INDEX_LOCK_UNKNOWN')
        rmSync(lock)
      }
      rmSync(deliveryLock)
    }
    writeFileSync(deliveryLock, JSON.stringify({ pid: process.pid, step: s.ref }), { flag: 'wx', mode: 0o600 })
    let lockOwned = false
    const scratch = mkdtempSync(join(storage, 'apply-')), privateIndex = join(scratch, 'index')
    try {
      const marker = Buffer.from('DSH_LOCAL_DELIVERY_LOCK:' + randomUUID())
      const fd = openSync(lock, 'wx', 0o600); closeSync(fd); lockOwned = true
      writeFileSync(lock, marker)
      const lockStat = lstatSync(lock), indexLockIdentity = { dev: lockStat.dev, ino: lockStat.ino, markerDigest: bytesDigest(marker) }
      if (journal) { journal.indexLockIdentity = indexLockIdentity; journal.indexLockOwner = process.pid; durable(path, journal) }
      const indexPath = join(s.realGitDir, 'index'), indexBytes = readFileSync(indexPath), indexHash = bytesDigest(indexBytes)
      if (!journal) {
        const planned = planLocalGitDelivery(s, storage)
        if (planned.finalTree !== s.finalTree || planned.plannedCommit !== s.plannedCommit) throw new Error('DELIVERY_PLAN_CHANGED')
        const parent = treeEntries(s.targetRoot, s.expectedParent), before: Journal['before'] = {}
        for (const p of [...s.manifest.map(e => e.path), ...s.deletions]) {
          const actual = fingerprint(s.targetRoot, p), old = parent.get(p), next = s.manifest.find(e => e.path === p)
          const oldFp = old ? { blob: old.blob, mode: old.mode } : null, newFp = next ? { blob: next.blob, mode: next.mode } : null
          if (!same(actual, oldFp) && !same(actual, newFp)) throw new Error('DELIVERY_WORKTREE_CHANGED')
          const staged = git(s.targetRoot, ['ls-files', '--stage', '--', p])
          const expectedOld = old ? `${old.mode} ${old.blob} 0\t${p}` : '', expectedNew = next ? `${next.mode} ${next.blob} 0\t${p}` : ''
          if (staged !== expectedOld && staged !== expectedNew) throw new Error('DELIVERY_STAGED_CONFLICT')
          // Do not silently remove user-owned special index semantics on delivery paths.
          const flags = git(s.targetRoot, ['ls-files', '-v', '--', p])
          if (flags && !flags.startsWith('H ')) throw new Error('DELIVERY_INDEX_FLAGS_CONFLICT')
          before[p] = actual
        }
        writeFileSync(privateIndex, indexBytes); writeEntries(s.targetRoot, privateIndex, s)
        const afterBytes = readFileSync(privateIndex)
        journal = { step: s, stage: 'planned', before, indexBefore: indexHash, indexAfter: bytesDigest(afterBytes), indexLockOwner: process.pid, indexLockIdentity }
        const artifact = join(storage, digest(s.ref) + '.index')
        if (existsSync(artifact)) { if (bytesDigest(readFileSync(artifact)) !== journal.indexAfter) throw new Error('DELIVERY_INDEX_EVIDENCE_CHANGED') }
        else writeFileSync(artifact, afterBytes, { flag: 'wx', mode: 0o600 })
        durable(path, journal); deps.checkpoint?.('planned')
      }
      if (![journal.indexBefore, journal.indexAfter].includes(indexHash)) throw new Error('DELIVERY_INDEX_CHANGED')
      live(s, envelope); assertDeliveryAcceptance(s, deps.readAcceptance(s)); validateManifest(s)
      if (git(s.targetRoot, ['rev-parse', 'HEAD']) === s.expectedParent) {
        git(s.targetRoot, ['update-ref', '-m', `dsh delivery ${s.ref.id}@${s.ref.revision}`, 'refs/heads/dev', s.plannedCommit, s.expectedParent])
      }
      if (git(s.targetRoot, ['rev-parse', 'HEAD']) !== s.plannedCommit) throw new Error('DELIVERY_HEAD_CHANGED')
      journal.stage = 'published'; durable(path, journal); deps.checkpoint?.('published')
      for (const p of [...s.manifest.map(e => e.path), ...s.deletions]) {
        live(s, envelope)
        if (git(s.targetRoot, ['rev-parse', 'HEAD']) !== s.plannedCommit) throw new Error('DELIVERY_HEAD_CHANGED')
        const next = s.manifest.find(e => e.path === p), expected = next ? { blob: next.blob, mode: next.mode } : null, actual = fingerprint(s.targetRoot, p)
        if (same(actual, expected)) continue
        if (!same(actual, journal.before[p])) throw new Error('DELIVERY_WORKTREE_CHANGED')
        const target = join(s.targetRoot, p)
        if (next) {
          const candidate = file(s.candidateRoot, p)!
          if (candidate.blob !== next.blob || candidate.mode !== next.mode) throw new Error('DELIVERY_CANDIDATE_CHANGED')
          mkdirSync(dirname(target), { recursive: true })
          const temp = join(dirname(target), '.dsh-delivery-' + digest({ step: s.ref, p }))
          writeFileSync(temp, candidate.bytes, { flag: 'wx', mode: next.mode === '100755' ? 0o755 : 0o644 })
          try {
            if (!same(fingerprint(s.targetRoot, p), journal.before[p])) throw new Error('DELIVERY_WORKTREE_CHANGED')
            renameSync(temp, target); chmodSync(target, next.mode === '100755' ? 0o755 : 0o644)
          } finally { rmSync(temp, { force: true }) }
        } else rmSync(target)
        journal.stage = 'worktree'; durable(path, journal); deps.checkpoint?.('worktree')
      }
      live(s, envelope)
      if (git(s.targetRoot, ['rev-parse', 'HEAD']) !== s.plannedCommit || bytesDigest(readFileSync(indexPath)) !== indexHash) throw new Error('DELIVERY_CONCURRENT_CHANGE')
      const nextIndex = readFileSync(join(storage, digest(s.ref) + '.index'))
      if (bytesDigest(nextIndex) !== journal.indexAfter) throw new Error('DELIVERY_INDEX_EVIDENCE_CHANGED')
      writeFileSync(lock, nextIndex); const fd2 = openSync(lock, 'r'); try { fsyncSync(fd2) } finally { closeSync(fd2) }
      renameSync(lock, indexPath); lockOwned = false
      const receipt: DeliveryReceipt = { stepRef: s.ref, targetRoot: s.targetRoot, realGitDir: s.realGitDir, branch: 'dev', parent: s.expectedParent, commit: s.plannedCommit, tree: s.finalTree, manifestDigest: manifestDigest(s), acceptanceRef: s.acceptanceRef, actionRef: envelope.actionRef, stage: 'aligned' }
      journal.stage = 'aligned'; journal.receipt = receipt; durable(path, journal); deps.checkpoint?.('aligned')
      return receipt
    } finally { if (lockOwned) rmSync(lock, { force: true }); rmSync(deliveryLock, { force: true }); rmSync(scratch, { recursive: true, force: true }) }
  }
  return Object.freeze({ executeLocalGitDelivery,
    verifyDeliveryReceipt(ref: Ref, receipt: DeliveryReceipt) {
      try { const s = load(ref).step; assertDeliveryAcceptance(s, deps.readAcceptance(s)); return deps.verifyReceipt(s, receipt) }
      catch (error) { return { verdict: 'fail' as const, reason: (error as Error).message, receipt: null } }
    },
    reconcile(ref: Ref) { const j = load(ref); return { stage: j.stage, receipt: j.receipt ?? null, head: git(j.step.targetRoot, ['rev-parse', 'HEAD']) } },
  })
}
