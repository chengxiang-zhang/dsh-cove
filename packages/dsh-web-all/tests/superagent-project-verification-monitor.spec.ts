import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const state = vi.hoisted(() => ({ root: '', inspections: 0, pending: false, revoked: false, retiredWhilePending: false }))
vi.mock('../src/host/services/superagent/executors/project-snapshot.ts', () => ({ verifyProjectSeal: () => true, copyVerifiedProjectSource: () => {} }))
vi.mock('../src/host/services/superagent/executors/project-keeper.ts', () => ({
  startProjectKeeper: async () => ({ root: state.root, instance: 'fixture', pid: 1, artifactDigest: 'fixture' }),
  inspectProjectKeeper: async () => {
    state.inspections++
    if (state.inspections === 3) {
      state.pending = true
      await new Promise(resolve => setTimeout(resolve, 300))
      state.pending = false
      if (state.revoked) return { current: false, reason: 'fixture revocation' }
    } else if (state.pending) return { current: false, reason: 'concurrent inspection' }
    return { current: true, status: { endpoints: [], broker: {}, qaSocketPaths: [] } }
  },
  retireProjectKeeper: async () => { state.retiredWhilePending = state.pending },
}))
vi.mock('../src/host/services/superagent/kernel/sandbox-launch-port.ts', () => ({
  createExternalSandboxLaunchPort: () => ({ open: () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { end() {
      setTimeout(() => { child.emit('exit', 0, null); child.emit('close') }, 1100)
    } }, cancel() {} })
    return child
  } }),
}))
import { runProjectVerification } from '../src/host/services/superagent/executors/project-verification.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
it.each([false, true])('drains an active monitor before final inspection and retirement (revoked=%s)', async revoked => {
  const root = mkdtempSync(join(tmpdir(), 'gate-monitor-')); roots.push(root)
  Object.assign(state, { root, inspections: 0, pending: false, revoked, retiredWhilePending: false })
  const dep = join(root, 'deps'), work = join(root, 'work'); mkdirSync(dep); mkdirSync(work)
  const observation = await runProjectVerification({
    sealedCandidate: { root, sourceRoot: root, dependencyRoots: { modules: dep, 'package-modules': dep, 'shared-modules': dep, pnpm: dep }, tools: { node: '/bin/sh' }, provenance: { source: 'fixture', revision: 'fixture' }, manifest: [], digest: 'fixture' },
    workRoot: work, collectorRoot: root, gate: 'typecheck', authorizationVersion: 'fixture', signal: new AbortController().signal, liveFence: () => true,
  })
  expect(state.pending).toBe(false)
  expect(state.retiredWhilePending).toBe(false)
  expect(observation.isolationCurrent).toBe(true)
  expect(observation.complete).toBe(!revoked)
  expect(observation.errors).toEqual(revoked ? ['PROJECT_LIVE_FENCE_REVOKED'] : [])
})
