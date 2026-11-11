import type { Ref } from './managed-work.ts'
import { createHash } from 'node:crypto'
import type { Workspace } from './execution.ts'
interface DeliveryAction {
  id: string; idempotencyKey: string; requester: string; subject: string; target: Ref; epoch: number
  mandateRef: Ref; capabilityRef: Ref; workspaceId: string; resourceIds: string[]; scopeRefs: Ref[]
  purpose: Workspace['role']; timeoutMs: number; processPolicy: 'single' | 'children'
}

export interface GitEntry { path: string; blob: string; mode: '100644' | '100755' }
export interface ExpectedDevTransition { stepRef: Ref; realGitDir: string; before: string; after: string }
export interface DeliveryStep {
  ref: Ref
  targetRoot: string
  realGitDir: string
  branch: 'dev'
  expectedParent: string
  candidateRoot: string
  manifest: GitEntry[]
  /** Deleted paths are explicit; the rest of the parent tree is retained. */
  deletions: string[]
  finalTree: string
  plannedCommit: string
  message: string
  authoredAt: number
  acceptanceRef: Ref
  requiredGateRefs: Ref[]
  action: DeliveryAction
}
export interface DeliveryAcceptance {
  ref: Ref
  candidateRef: Ref
  evaluationRef: Ref
  finalTree: string
  manifestDigest: string
  gateRefs: Ref[]
}
export interface DeliveryReceipt {
  stepRef: Ref
  targetRoot: string
  realGitDir: string
  branch: 'dev'
  parent: string
  commit: string
  tree: string
  manifestDigest: string
  acceptanceRef: Ref
  actionRef: Ref
  stage: 'published' | 'aligned'
}
export interface DeliveryEvaluation {
  verdict: 'pass' | 'fail'
  reason: string
  receipt: DeliveryReceipt | null
}

export const LOCAL_GIT_DELIVERY = '/dsh-host/local-git-delivery@1'
export function deliveryActionSpec(step: DeliveryStep) {
  return { ...step.action, kind: 'deliver' as const, executable: LOCAL_GIT_DELIVERY, args: [] as string[], payloadDigest: createHash('sha256').update(JSON.stringify(step)).digest('hex'),
    expectedDevTransition: { stepRef: step.ref, realGitDir: step.realGitDir, before: step.expectedParent, after: step.plannedCommit } }
}

export function deliveryReportText(r: DeliveryReceipt): string { return `已核对本地 dev 提交 ${r.commit}，交付范围、文件模式、工作树及暂存区与验收版本一致。未推送，未上线。` }
