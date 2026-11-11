export interface Workspace {
 id: string; root: string; source: string; repositoryId: string; baseline: string; branch: string
 resources: string[]; sourceStatus: string; role: 'engineering' | 'qa_prepare' | 'candidate' | 'collector'
}
/** The identity is the write domain, not just the checkout path. */
export function resourceIds(repositoryId: string, branch: string, environment?: string): string[] {
 if (!repositoryId.trim() || !branch.trim()) throw new Error('RESOURCE_IDENTITY_REQUIRED')
 return [`repository:${repositoryId}`, `branch:${repositoryId}:${branch}`, ...(environment ? [`environment:${environment}`] : [])]
}
