import { git, file, identity, commitBytes, manifestDigest, treeEntries } from '../executors/delivery/git.ts'
import type { DeliveryStep, DeliveryReceipt, DeliveryEvaluation } from '../protocol/delivery.ts'
/** Independently reads Git and the actual checkout. Receipt fields are assertions, never evidence. */
export function inspectDeliveryReceipt(s: DeliveryStep, receipt: DeliveryReceipt): DeliveryEvaluation {
  try {
    identity(s)
    if (!receipt || receipt.stage !== 'aligned' || JSON.stringify(receipt.stepRef) !== JSON.stringify(s.ref) || receipt.targetRoot !== s.targetRoot || receipt.realGitDir !== s.realGitDir || receipt.branch !== 'dev' || receipt.parent !== s.expectedParent || receipt.commit !== s.plannedCommit || receipt.tree !== s.finalTree || receipt.manifestDigest !== manifestDigest(s) || JSON.stringify(receipt.acceptanceRef) !== JSON.stringify(s.acceptanceRef) || receipt.actionRef?.id !== s.action.id) throw new Error('DELIVERY_RECEIPT_MISMATCH')
    if (git(s.targetRoot, ['rev-parse', 'HEAD']) !== s.plannedCommit || git(s.targetRoot, ['cat-file', 'commit', s.plannedCommit]) !== commitBytes(s).trimEnd()) throw new Error('DELIVERY_COMMIT_MISMATCH')
    const actual = treeEntries(s.targetRoot, s.plannedCommit), expected = treeEntries(s.targetRoot, s.expectedParent)
    for (const e of s.manifest) expected.set(e.path, e)
    for (const p of s.deletions) expected.delete(p)
    if (actual.size !== expected.size || [...actual].some(([p, e]) => e.blob !== expected.get(p)?.blob || e.mode !== expected.get(p)?.mode)) throw new Error('DELIVERY_SCOPE_MISMATCH')
    for (const p of [...s.manifest.map(e => e.path), ...s.deletions]) {
      const e = expected.get(p), actualFile = file(s.targetRoot, p)
      if (e ? !actualFile || actualFile.blob !== e.blob || actualFile.mode !== e.mode : actualFile !== null) throw new Error('DELIVERY_WORKTREE_MISMATCH')
      if (git(s.targetRoot, ['ls-files', '--stage', '--', p]) !== (e ? `${e.mode} ${e.blob} 0\t${p}` : '')) throw new Error('DELIVERY_INDEX_MISMATCH')
    }
    return { verdict: 'pass', reason: 'Exact local dev commit, tree, modes, scope, index and worktree independently observed; no push or deployment.', receipt }
  } catch (error) { return { verdict: 'fail', reason: (error as Error).message, receipt: null } }
}
