import type { Ref } from '../protocol/managed-work.ts'
export interface ControlLease { target: Ref; holder: string; epoch: number; expiresAt: number; revoked: boolean }
export interface ControlReceipt { target: Ref; source: Ref; epoch: number; expiresAt: number; status: 'confirmed' | 'unknown'; evidenceRefs: string[] }
export interface Mandate {
 id: string; revision: number; requester: string; subject: string; target: Ref; actions: string[]
 workspaceId: string; resourceIds: string[]; scopeRefs: Ref[]; expiresAt: number; revoked: boolean; source: Ref
}
export interface Denial { kind: 'denial'; code: string; basis: string[] }
