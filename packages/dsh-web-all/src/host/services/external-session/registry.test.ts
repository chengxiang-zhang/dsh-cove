/**
 * The registry as the host assembly actually builds it.
 *
 * This suite exists because a harness that injects its own
 * `Partial<Record<provider, adapter>>` cannot catch a provider missing from
 * `createAdapterRegistry`: every engine test passed while `subagent_codex`
 * returned 501 on a real host. So these tests never inject an adapter — they
 * call the registry the way `register(ctx)` does, and then drive the engine with
 * what it returned.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { resolveExternalSessionConfig } from './config.ts'
import { createAdapterRegistry } from './registry.ts'
import { ExternalSessionEngine } from './engine.ts'
import { ExternalSessionStore } from './store.ts'
import { MemoryStoreFileSystem } from './test-doubles.ts'

const PATH = '/tmp/dsh-external-session-registry.json'

/** A context whose executable lookup answers from a fixed table. */
function contextWithBinaries(binaries: Record<string, string | null>): Context {
  const ctx = new Context()
  ctx.provide('subprocess', {
    async resolveExecutable(command: string) {
      return binaries[command] ?? null
    },
    spawn(): never {
      throw new Error('this suite never spawns a process')
    },
  })
  return ctx
}

function registryFor(binaries: Record<string, string | null>) {
  const config = resolveExternalSessionConfig({ storePath: PATH, claudeBin: '/opt/claude', codexBin: '/opt/codex' }, '/tmp/home')
  const ctx = contextWithBinaries(binaries)
  return { config, ctx, registry: createAdapterRegistry(ctx, config) }
}

describe('adapter registry built by the host assembly', () => {
  it('ships an adapter for every provider the design names', () => {
    const { registry } = registryFor({ '/opt/claude': '/opt/claude', '/opt/codex': '/opt/codex' })
    // The exact failure this suite was written for: a missing key here is a
    // permanent 501 on a real host, invisible to any test that injects adapters.
    expect(Object.keys(registry).sort()).toEqual(['claude', 'codex'])
    expect(registry.claude.provider).toBe('claude')
    expect(registry.codex.provider).toBe('codex')
  })

  it('resolves each provider through its own configured binary', async () => {
    const { registry } = registryFor({ '/opt/claude': '/opt/claude', '/opt/codex': '/opt/codex' })
    await expect(registry.claude.resolveExecutable()).resolves.toBe('/opt/claude')
    await expect(registry.codex.resolveExecutable()).resolves.toBe('/opt/codex')
  })

  it('keeps the providers independent when one binary is missing', async () => {
    // Codex installed, Claude absent.
    const codexOnly = registryFor({ '/opt/codex': '/opt/codex' })
    await expect(codexOnly.registry.codex.resolveExecutable()).resolves.toBe('/opt/codex')
    await expect(codexOnly.registry.claude.resolveExecutable()).resolves.toBeNull()

    // Claude installed, Codex absent: the engine refuses one and not the other.
    const claudeOnly = registryFor({ '/opt/claude': '/opt/claude' })
    await expect(claudeOnly.registry.claude.resolveExecutable()).resolves.toBe('/opt/claude')
    await expect(claudeOnly.registry.codex.resolveExecutable()).resolves.toBeNull()

    const store = new ExternalSessionStore({ storePath: PATH, maxSessions: 100, fs: new MemoryStoreFileSystem() })
    const engine = new ExternalSessionEngine({
      config: claudeOnly.config,
      store,
      adapters: claudeOnly.registry,
      directoryProbe: async () => true,
    })
    // A codex call reports the missing CLI rather than a missing capability, and
    // the claude adapter is untouched by it.
    expect(await engine.runTurn({ provider: 'codex', prompt: 'go', cwd: '/tmp' }))
      .toMatchObject({ code: 'provider-missing' })
    await expect(claudeOnly.registry.claude.resolveExecutable()).resolves.toBe('/opt/claude')
  })

  it('reports an unknown provider id rather than inventing an adapter', () => {
    const { registry } = registryFor({})
    expect(registry['gemini' as 'claude']).toBeUndefined()
  })
})