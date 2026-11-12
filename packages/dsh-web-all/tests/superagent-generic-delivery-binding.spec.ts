import { describe, expect, it, vi } from 'vitest'
import type { ManagedLedger } from '../src/host/services/superagent/kernel/managed-ledger.ts'
import type { DeliveryStep } from '../src/host/services/superagent/protocol/delivery.ts'
import { managedVerificationMethod, methodAssetDigest } from '../src/host/services/superagent/executors/managed-verification-method.ts'
import { readDeliveryAcceptance, type DeliveryAcceptanceBinding } from '../src/host/services/superagent/verification/delivery-acceptance.ts'

const artifacts = vi.hoisted(() => ({ bytes: Buffer.alloc(0) }))
vi.mock('../src/host/services/superagent/executors/project-snapshot.ts', () => ({ verifyProjectSeal: () => true }))
vi.mock('../src/host/services/superagent/kernel/verification-ledger.ts', () => ({ verificationScopes: () => [{ id: 'evaluation', revision: 1 }] }))
vi.mock('../src/host/services/superagent/executors/delivery/git.ts', () => ({
  treeEntries: () => new Map(), manifestDigest: () => 'unused',
  file: (root: string) => root === 'candidate' ? { bytes: artifacts.bytes } : undefined,
}))

function fixture() {
  const ref = (id: string) => ({ id, revision: 1 })
  const method = managedVerificationMethod('javascript-module@1', { entryPath: 'public/api.mjs' })
  artifacts.bytes = Buffer.from(method.assets['candidate.mjs']!)
  const objects = [
    { id: 'commitment', kind: 'commitment', data: { state: 'delivering', control_state: 'autonomous', acceptance_contract: ref('contract'), delivery_contract: ref('delivery-contract'), requirement_refs: [] } },
    { id: 'evaluation', kind: 'evaluation', data: { verdict: 'pass', commitment_id: 'commitment', candidate_ref: ref('candidate'), contract_ref: ref('contract') } },
    { id: 'contract', kind: 'acceptance_contract', data: { requirement_refs: [] } },
    { id: 'delivery-contract', kind: 'delivery_contract', data: {} },
    { id: 'candidate', kind: 'candidate', data: { root: 'candidate', manifest: [{ path: 'candidate.mjs', digest: methodAssetDigest(artifacts.bytes.toString()) }] } },
  ].map(o => ({ ...o, revision: 1 }))
  const ledger = { get: (id: string) => objects.find(o => o.id === id), applicability: () => 'usable', snapshot: () => objects } as unknown as ManagedLedger
  const step = { acceptanceRef: ref('acceptance'), action: { target: ref('commitment') }, targetRoot: 'project', finalTree: 'tree', requiredGateRefs: [] } as unknown as DeliveryStep
  const binding: DeliveryAcceptanceBinding = { ref: ref('acceptance'), candidate: ref('candidate'), evaluation: ref('evaluation'), seal: { sourceRoot: 'sealed', manifest: [] } as unknown as DeliveryAcceptanceBinding['seal'], authorizationVersion: 'v1', method: { id: method.id, assetsDigest: methodAssetDigest(JSON.stringify(method.assets)), settings: { entryPath: 'public/api.mjs' } }, gates: [] }
  return { ledger, step, binding }
}

describe('generic method delivery binding reconstruction', () => {
  it('reconstructs the configured asset and still requires every project gate', () => {
    const { ledger, step, binding } = fixture()
    expect(() => readDeliveryAcceptance(ledger, step, binding)).toThrow('DELIVERY_ACCEPTANCE_GATES')
  })
  it('refuses changed settings or modified generated asset bytes', () => {
    const { ledger, step, binding } = fixture()
    expect(() => readDeliveryAcceptance(ledger, step, { ...binding, method: { ...binding.method!, settings: { entryPath: 'public/other.mjs' } } })).toThrow('DELIVERY_ACCEPTANCE_CANDIDATE')
    artifacts.bytes = Buffer.from('export const inspect = () => true')
    expect(() => readDeliveryAcceptance(ledger, step, binding)).toThrow('DELIVERY_ACCEPTANCE_CANDIDATE')
  })
})
