import { DELIVERY_EVIDENCE_POLICY } from '../kernel/contract-partition.ts'
import { execFileSync } from 'node:child_process'
import { hostProgramAsset } from '../executors/host-program-assets.ts'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { ManagedLedger } from '../kernel/managed-ledger.ts'
import { verificationScopes } from '../kernel/verification-ledger.ts'
import { verifyProjectSeal, type ProjectSeal } from '../executors/project-snapshot.ts'
import type { DeliveryAcceptance, DeliveryStep } from '../protocol/delivery.ts'
import type { Ref } from '../protocol/managed-work.ts'
import { managedVerificationMethod, methodAssetDigest } from '../executors/managed-verification-method.ts'
import { treeEntries, file, manifestDigest } from '../executors/delivery/git.ts'
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
export interface DeliveryAcceptanceBinding {
  ref: Ref
  candidate: Ref
  evaluation: Ref
  /** Mode-aware whole final tree used by every project gate; old byte-only seals cannot enter. */
  seal: ProjectSeal
  authorizationVersion: string
  method?: { id: string; assetsDigest: string }
  gates: { ref: Ref; gate: string; observationPath: string; observationDigest: string }[]
}
/** Host composition resolves immutable collector artifacts, never model-supplied pass booleans. */
export function readDeliveryAcceptance(ledger: ManagedLedger, s: DeliveryStep, binding: DeliveryAcceptanceBinding, historical = false): DeliveryAcceptance {
  const current = (r: Ref, kind: string) => {
    const o = ledger.get(r.id)
    if (!o || o.kind !== kind || o.revision !== r.revision || ledger.applicability(o.id) !== 'usable') throw new Error('DELIVERY_ACCEPTANCE_STALE')
    return o
  }
  if (!same(binding.ref, s.acceptanceRef) || !binding.authorizationVersion || !verifyProjectSeal(binding.seal)) throw new Error('DELIVERY_ACCEPTANCE_SEAL')
  const recorded = historical && ledger.eventEntries({deliveryStep:s.ref}).some(({body:event}) => { const x = event as unknown as { delivery?: string; step?: DeliveryStep }; return x.delivery === 'fulfilled' && same(x.step, s) })
  const c = recorded ? current({ id: s.action.target.id, revision: s.action.target.revision + 1 }, 'commitment') : current(s.action.target, 'commitment'), e = current(binding.evaluation, 'evaluation'), candidate = current(binding.candidate, 'candidate')
  if ((c.data.state !== 'delivering' && !(recorded && c.data.state === 'fulfilled')) || c.data.control_state !== 'autonomous' || e.data.verdict !== 'pass' || e.data.commitment_id !== c.id || !same(e.data.candidate_ref, binding.candidate) || !same(e.data.contract_ref, c.data.acceptance_contract)) throw new Error('DELIVERY_ACCEPTANCE_EVALUATION')
  // A child matrix cannot stand in for an inherited outcome contract.
  let parent = c.data.parent_id ? ledger.get(String(c.data.parent_id)) : undefined
  const seen = new Set<string>([c.id])
  const contract = current(e.data.contract_ref as unknown as Ref, 'acceptance_contract')
  if ((c.data.requirement_refs as unknown as Ref[]).some(r => !(contract.data.requirement_refs as unknown as Ref[]).some(x => same(r, x)))) throw new Error('DELIVERY_REQUIREMENT_COVERAGE_REQUIRED')
  while (parent) {
    if (seen.has(parent.id) || parent.kind !== 'commitment' || parent.data.control_state !== 'autonomous' || ['fulfilled', 'released', 'withdrawn', 'broken'].includes(String(parent.data.state)) || ledger.applicability(parent.id) !== 'usable') throw new Error('DELIVERY_PARENT_FENCED')
    seen.add(parent.id)
    const parentContract = parent.data.acceptance_contract && current(parent.data.acceptance_contract as unknown as Ref, 'acceptance_contract')
    const requirements = parent.data.requirement_refs as unknown as Ref[]
    const covered = contract.data.requirement_refs as unknown as Ref[]
    const criteria = contract.data.criterion_refs as unknown as Ref[]
    if (requirements.some(r => !covered.some(x => same(r, x))) || !parentContract || (parentContract.data.criterion_refs as unknown as Ref[]).some(r => !criteria.some(x => same(r, x)))) throw new Error('DELIVERY_PARENT_COVERAGE_REQUIRED')
    parent = parent.data.parent_id ? ledger.get(String(parent.data.parent_id)) : undefined
  }
  const deliveryContract = current(c.data.delivery_contract as unknown as Ref, 'delivery_contract')
  if (deliveryContract.data.criterion_refs !== undefined) {
    if (deliveryContract.data.evidence_policy !== DELIVERY_EVIDENCE_POLICY) throw Error('DELIVERY_ENGINEERING_POLICY_REQUIRED')
    for (const criterion of deliveryContract.data.criterion_refs as unknown as Ref[]) current(criterion, 'requirement')
  }
  const scopes = verificationScopes(ledger, c.id)
  if (!scopes.some(r => same(r, binding.evaluation)) || scopes.some(r => ledger.get(r.id)?.revision !== r.revision || ledger.applicability(r.id) !== 'usable')) throw new Error('DELIVERY_ACCEPTANCE_STALE')
  for (const r of scopes) {
    const o = ledger.get(r.id)!
    if (o.kind === 'qualification' && (o.data.revoked || Number(o.data.expires_at) <= Date.now())) throw new Error('DELIVERY_ACCEPTANCE_QUALIFICATION')
  }
  if (ledger.snapshot().some(o => o.kind === 'review_issue' && same(o.data.contract_ref, e.data.contract_ref) && !['resolved', 'dismissed'].includes(String(o.data.state)))) throw new Error('DELIVERY_ACCEPTANCE_OPEN_REVIEW')
  const tree = treeEntries(s.targetRoot, s.finalTree), sourceEntries = binding.seal.manifest.filter(x => x.path.startsWith('source/') && x.kind !== 'directory')
  if (sourceEntries.length !== tree.size) throw new Error('DELIVERY_ACCEPTANCE_TREE')
  for (const entry of sourceEntries) {
    const path = entry.path.slice('source/'.length), expected = tree.get(path), actual = file(binding.seal.sourceRoot, path)
    if (entry.kind !== 'file' || typeof entry.executable !== 'boolean' || !expected || !actual || actual.blob !== expected.blob || actual.mode !== expected.mode || entry.executable !== (expected.mode === '100755')) throw new Error('DELIVERY_ACCEPTANCE_TREE_MODE')
  }
  const candidateManifest = candidate.data.manifest as unknown as { path: string; digest: string }[]
  if (!Array.isArray(candidateManifest) || !candidateManifest.length) throw new Error('DELIVERY_ACCEPTANCE_CANDIDATE')
  for (const entry of candidateManifest) {
    const sealed = file(binding.seal.sourceRoot, entry.path), evaluated = file(String(candidate.data.root), entry.path)
    if (!sealed && binding.method && evaluated) {
      const method = managedVerificationMethod(binding.method.id)
      const asset = method.assets[entry.path]
      if (binding.method.assetsDigest === methodAssetDigest(JSON.stringify(method.assets)) && asset !== undefined && methodAssetDigest(asset) === entry.digest && hash(evaluated.bytes) === entry.digest) continue
    }
    if (!sealed || !evaluated || hash(sealed.bytes) !== entry.digest || hash(evaluated.bytes) !== entry.digest) throw new Error('DELIVERY_ACCEPTANCE_CANDIDATE')
  }
  const requiredGates = ['typecheck', 'test', 'docs:check', 'build', 'test:scripts', 'runtime-deps:check', 'sync-shared:check']
  if (requiredGates.some(g => !binding.gates.some(x => x.gate === g)) || new Set(binding.gates.map(x => x.gate)).size !== binding.gates.length || !same(binding.gates.map(x => x.ref), s.requiredGateRefs)) throw new Error('DELIVERY_ACCEPTANCE_GATES')
  const keeperRefs: unknown[] = []
  for (const gate of binding.gates) {
    const bytes = readFileSync(gate.observationPath)
    if (hash(bytes) !== gate.observationDigest) throw new Error('DELIVERY_GATE_EVIDENCE_CHANGED')
    const observation = JSON.parse(bytes.toString())
    if (observation.sourceDigest !== binding.seal.digest || observation.authorizationVersion !== binding.authorizationVersion || observation.gate !== gate.gate || observation.planVersion !== 'project-gates-v2' || observation.complete !== true || observation.isolationCurrent !== true || observation.exit?.observed !== true || observation.exit?.code !== 0 || observation.exit?.signal !== null || !Array.isArray(observation.errors) || observation.errors.length || !Array.isArray(observation.steps) || !observation.steps.length || !same(observation.plan, observation.steps.map((x: { gate: string }) => x.gate))) throw new Error('DELIVERY_GATE_NOT_PASS')
    keeperRefs.push(observation.keeperRef)
    for (const step of observation.steps) {
      if (!step.complete || step.exit?.observed !== true || step.exit?.code !== 0 || step.exit?.signal !== null || !Array.isArray(step.errors) || step.errors.length || !same(step.command, ['pnpm', step.gate])) throw new Error('DELIVERY_GATE_NOT_PASS')
      for (const output of [step.stdout, step.stderr]) if (!output?.path || hash(readFileSync(output.path)) !== output.sha256) throw new Error('DELIVERY_GATE_RAW_CHANGED')
    }
  }
  try {
    const result = execFileSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', hostProgramAsset('delivery')], { input: JSON.stringify(keeperRefs), encoding: 'utf8', timeout: 15000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C', ...(process.env.DSH_P7_KEEPER_FIXTURE ? { DSH_P7_KEEPER_FIXTURE: process.env.DSH_P7_KEEPER_FIXTURE } : {}) }, stdio: ['pipe','pipe','pipe'] })
    if (result !== 'current') throw Error('not current')
  } catch { throw new Error('DELIVERY_GATE_KEEPER_NOT_CURRENT') }
  return { ref: binding.ref, candidateRef: binding.candidate, evaluationRef: binding.evaluation, finalTree: s.finalTree, manifestDigest: manifestDigest(s), gateRefs: binding.gates.map(x => x.ref) }
}
