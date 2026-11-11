import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedAdmission } from '../src/host/services/superagent/managed-runtime.ts'
import { managedWorkRoutes } from '../src/host/services/superagent/surface/managed-routes.ts'
const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
it('durably admits once before native work, preserves failure evidence, and shares the trusted HTTP entrance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'managed-admission-')), source = join(dir, 'source'), root = join(dir, 'host'); mkdirSync(source); writeFileSync(join(source, 'input.ts'), 'export const value = 1')
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const bootstrap = join(dir, 'bootstrap.json')
  writeFileSync(bootstrap, JSON.stringify({ root, defaultProject: 'project', projects: { project: { projectRoot: source, publicFiles: ['input.ts'], implementationWritePaths: ['input.ts'], engine: { executable: '/never-execute-fixture', authFile: join(dir, 'absent-auth'), model: 'fixture' } } } }), { mode: 0o600 })
  const results: string[] = [], port = createManagedAdmission({ bootstrapFile: bootstrap }, (_request, result) => results.push(result.state)); cleanup.push(() => port.dispose())
  const request = { requestId: 'owner-message', text: 'Implement the requested behavior', origin: { kind: 'trusted-host' as const } }
  expect(port.enqueue(request)).toMatchObject({ state: 'queued', duplicate: false })
  expect(port.read(request.requestId).state).toBe('queued')
  expect(port.enqueue(request)).toMatchObject({ duplicate: true })
  expect(() => port.enqueue({ ...request, text: 'different request under the same id' })).toThrow('MANAGED_ADMISSION_CONFLICT')
  await port.settle()
  expect(port.read(request.requestId)).toMatchObject({ state: 'needs-attention', error: expect.stringContaining('ENOENT') })
  expect(results).toEqual(['needs-attention']); expect(readdirSync(join(root, 'jobs'))).toHaveLength(1)
  const routes = managedWorkRoutes(port, request => request.headers['x-test-owner'] === 'yes')
  const server = createServer((request, response) => { const route = routes.find(route => route.path === request.url); if (!route) { response.writeHead(404).end(); return }; void route.handler(request, response) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}/superagent/managed/`
  expect((await fetch(url + 'projects')).status).toBe(403)
  expect(await (await fetch(url + 'projects', { headers: { 'x-test-owner': 'yes' } })).json()).toMatchObject([{ id: 'project' }])
  const duplicate = await fetch(url + 'intake', { method: 'POST', headers: { 'x-test-owner': 'yes' }, body: JSON.stringify({ requestId: request.requestId, text: request.text }) })
  expect(duplicate.status).toBe(202); expect(await duplicate.json()).toMatchObject({ duplicate: true })
  const injection = await fetch(url + 'intake', { method: 'POST', headers: { 'x-test-owner': 'yes' }, body: JSON.stringify({ requestId: 'other', text: 'request', engine: { executable: '/bin/sh' } }) })
  expect(injection.status).toBe(400)
  expect(readFileSync(bootstrap, 'utf8')).not.toContain('token')
})
