import { describe, expect, it } from 'vitest'
import { resolvePlugins } from '../src/host/services/superagent/plugins/registry'
import { createGenerationAuthority, prepareGeneration } from '../src/host/services/superagent/plugins/lifecycle'
import type { PluginManifest, PluginCapabilities } from '../src/host/services/superagent/plugins/contracts'

const capabilities: PluginCapabilities = {
  contract_version: '1.0.0', schema_versions: ['1'], permissions: ['observe'],
  extensions: [], isolated_modes: ['trusted-in-process'], now: 10,
  qualifications: [{ plugin_id: 'observer', version: '1.0.0', evidence_ref: 'test:observer', expires_at: 100 }],
}
function manifest(id = 'observer'): PluginManifest {
  return { id, namespace: id, version: '1.0.0', contract_version: '^1.0.0',
    provides: [{ id: id + '.observe', version: '1.0.0' }], requires: [],
    compatible_schema_versions: ['1'], config_schema: { validate: value => value === undefined },
    owned_state_schemas: [{ id: 'cursor', version: '1', retention: 'retain' }],
    migration_refs: [], permission_requirements: ['observe'], isolation_mode: 'trusted-in-process',
    reload_class: 'domain-controlled', contract_test_refs: ['test:observer'], required_extensions: [] }
}
function graph(ms = [manifest()], caps = capabilities) {
  const result = resolvePlugins(ms, caps)
  if (!result.ok) throw new Error(JSON.stringify(result))
  return result
}
describe('plugin admission', () => {
  it('admits a new observer with no business-name branch', () => {
    expect(graph().order).toEqual(['observer'])
  })
  it('admits separate provider bindings of the same executor contract', () => {
    const a = manifest('engine-a'), b = manifest('engine-b')
    a.provides = [{ id: 'runtime:a', contract: 'executor', version: '1.0.0' }]
    b.provides = [{ id: 'runtime:b', contract: 'executor', version: '1.0.0' }]
    const caps = { ...capabilities, qualifications: [a, b].map(m => ({ plugin_id: m.id, version: m.version, evidence_ref: 'test:observer', expires_at: 100 })) }
    expect(graph([a, b], caps).providers.size).toBe(2)
  })
  it('rejects missing dependencies and incompatible port versions with locations', () => {
    const m = manifest(); m.requires = [{ id: 'missing', version: '^1.0.0' }]
    expect(resolvePlugins([m], capabilities)).toMatchObject({ ok: false, code: 'DEPENDENCY_MISSING', plugin_id: 'observer', subject: 'missing' })
    m.requires = [{ id: 'observer.observe', version: '^2.0.0' }]
    expect(resolvePlugins([m], capabilities)).toMatchObject({ ok: false, code: 'PORT_VERSION_INCOMPATIBLE' })
  })
  it('rejects dependency cycles, duplicate providers and incompatible contracts', () => {
    const a = manifest('a'), b = manifest('b')
    a.requires = [{ id: 'b.observe', version: '*' }]; b.requires = [{ id: 'a.observe', version: '*' }]
    expect(resolvePlugins([a, b], capabilities)).toMatchObject({ ok: false, code: 'DEPENDENCY_CYCLE' })
    b.provides = a.provides
    expect(resolvePlugins([a, b], capabilities)).toMatchObject({ ok: false, code: 'PORT_CONFLICT' })
    a.contract_version = '^2.0.0'
    expect(resolvePlugins([a], capabilities)).toMatchObject({ ok: false, code: 'CONTRACT_INCOMPATIBLE' })
  })
  it('fails closed for configuration, extensions, permissions, schemas, isolation and qualification', () => {
    for (const [field, value, code] of [
      ['config', {}, 'CONFIG_INVALID'], ['required_extensions', ['unknown'], 'EXTENSION_MISSING'],
      ['permission_requirements', ['write'], 'PERMISSION_MISSING'], ['compatible_schema_versions', ['2'], 'SCHEMA_INCOMPATIBLE'],
      ['isolation_mode', 'process', 'ISOLATION_UNAVAILABLE'],
    ] as const) {
      expect(resolvePlugins([{ ...manifest(), [field]: value }], capabilities)).toMatchObject({ ok: false, code })
    }
    expect(resolvePlugins([manifest()], { ...capabilities, qualifications: [] })).toMatchObject({ ok: false, code: 'QUALIFICATION_MISSING' })
    expect(resolvePlugins([manifest()], { ...capabilities, now: 101 })).toMatchObject({ ok: false, code: 'QUALIFICATION_MISSING' })
  })
})
describe('bounded generation', () => {
  it('prepare has no business effects, binds ports and fences retired callbacks', () => {
    const prepared = prepareGeneration(graph(), { authority: createGenerationAuthority(), in_flight: [] })
    expect(prepared.state).toBe('prepared')
    expect(() => prepared.port('observer.observe')).toThrow(/not active/)
    prepared.register('observer', 'observer.observe', { read: () => 7 })
    prepared.activate()
    const port = prepared.port<{ read(): number }>('observer.observe')
    expect(port.invoke(value => value.read())).toBe(7)
    expect(() => prepared.writePrivate('observer', 'other', 'cursor', () => 1)).toThrow(/private/)
    expect(prepared.writePrivate('observer', 'observer', 'cursor', () => 2)).toBe(2)
    prepared.beginDrain(20)
    expect(prepared.retire(19, ['binding:old'])).toEqual({ ok: false, reason: 'IN_FLIGHT' })
    expect(prepared.retire(20, ['binding:old'])).toEqual({ ok: false, reason: 'DRAIN_TIMEOUT' })
    expect(prepared.retire(20, [])).toEqual({ ok: true })
    expect(() => port.invoke(value => value.read())).toThrow(/generation/)
  })
  it('fences old active objects and competing preparations using shared CAS', () => {
    const authority = createGenerationAuthority()
    const old = prepareGeneration(graph(), { authority, in_flight: [] })
    old.register('observer', 'observer.observe', {})
    old.activate()
    const oldPort = old.port('observer.observe')
    const next = prepareGeneration(graph(), { authority, in_flight: [] })
    const competing = prepareGeneration(graph(), { authority, in_flight: [] })
    next.register('observer', 'observer.observe', {})
    competing.register('observer', 'observer.observe', {})
    next.activate()
    expect(() => oldPort.invoke(() => 1)).toThrow(/generation/)
    expect(() => old.writePrivate('observer', 'observer', 'cursor', () => 1)).toThrow(/generation/)
    expect(() => competing.activate()).toThrow(/stale generation/)
  })
  it('rechecks revoked admission before activation', () => {
    const caps = { ...capabilities, permissions: ['observe'] }
    const prepared = prepareGeneration(graph([manifest()], caps), { authority: createGenerationAuthority(), in_flight: [] })
    prepared.register('observer', 'observer.observe', {})
    caps.permissions = []
    expect(() => prepared.activate()).toThrow(/PERMISSION_MISSING/)
  })
  it('does not claim multiversion loading or allow activation over live old bindings', () => {
    const blocked = prepareGeneration(graph(), { authority: createGenerationAuthority(1), in_flight: ['old'] })
    blocked.register('observer', 'observer.observe', {})
    expect(blocked.state).toBe('prepared')
    expect(() => blocked.activate()).toThrow(/in.flight/)
    const prepared = prepareGeneration(graph(), { authority: createGenerationAuthority(1), in_flight: [] })
    expect(prepared.loading_mode).toBe('domain-controlled')
    expect(() => prepared.activate()).toThrow(/unregistered/)
  })
})

describe('review regression cases', () => {
  it('holds async invocations across drain, timeout and next activation until settle', async () => {
    const authority = createGenerationAuthority()
    const old = prepareGeneration(graph(), { authority, in_flight: [] })
    old.register('observer', 'observer.observe', {})
    old.activate()
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const pending = old.port('observer.observe').invoke(async () => { await barrier; return 7 })
    old.beginDrain(20)
    expect(old.retire(19, [])).toEqual({ ok: false, reason: 'IN_FLIGHT' })
    expect(old.retire(20, [])).toEqual({ ok: false, reason: 'DRAIN_TIMEOUT' })
    const next = prepareGeneration(graph(), { authority, in_flight: [] })
    next.register('observer', 'observer.observe', {})
    expect(() => next.activate()).toThrow(/in.flight/)
    release()
    expect(await pending).toBe(7)
    expect(old.retire(21, [])).toEqual({ ok: true })
    next.activate()
    expect(authority.current()).toBe(2)
  })
  it('releases async rejection and synchronous throw invocation holds', async () => {
    const authority = createGenerationAuthority()
    const old = prepareGeneration(graph(), { authority, in_flight: [] })
    old.register('observer', 'observer.observe', {})
    old.activate()
    const port = old.port('observer.observe')
    expect(() => port.invoke(() => { throw new Error('sync') })).toThrow('sync')
    await expect(port.invoke(async () => { throw new Error('async') })).rejects.toThrow('async')
    old.beginDrain(20)
    expect(old.retire(10, [])).toEqual({ ok: true })
  })
  it('rejects incompatible or omitted dependency contract against an explicit contract', () => {
    const provider = manifest(), consumer = manifest('consumer')
    provider.provides = [{ id: 'runtime', version: '1.0.0', contract: 'observer' }]
    consumer.requires = [{ id: 'runtime', version: '1.0.0', contract: 'executor' }]
    const caps = { ...capabilities, qualifications: [...capabilities.qualifications, { plugin_id: 'consumer', version: '1.0.0', evidence_ref: 'test:observer', expires_at: 100 }] }
    expect(resolvePlugins([provider, consumer], caps)).toMatchObject({ ok: false, code: 'PORT_CONTRACT_INCOMPATIBLE', plugin_id: 'consumer', subject: 'runtime' })
    consumer.requires = [{ id: 'runtime', version: '1.0.0' }]
    expect(resolvePlugins([provider, consumer], caps)).toMatchObject({ ok: false, code: 'PORT_CONTRACT_INCOMPATIBLE' })
  })
  it('exposes immutable snapshots with no mutable map or schema authorization escape', () => {
    const m = manifest()
    const resolved = graph([m])
    const prepared = prepareGeneration(resolved, { authority: createGenerationAuthority(), in_flight: [] })
    prepared.register('observer', 'observer.observe', {})
    prepared.activate()
    const injected = { id: 'unvalidated', version: '1', retention: 'retain' }
    expect(() => (resolved.manifests[0]!.owned_state_schemas as unknown[]).push(injected)).toThrow()
    expect(() => (resolved.manifests as unknown[]).push({ ...m, owned_state_schemas: [injected] })).toThrow()
    expect((resolved.providers as Map<string, unknown>).set).toBeUndefined()
    ;(m.owned_state_schemas as unknown[]).push(injected)
    expect(() => prepared.writePrivate('observer', 'observer', 'unvalidated', () => 42)).toThrow(/private/)
    expect(resolved.checkAdmission()).toBeUndefined()
  })
  it('reads fresh capability source and clock on activation and invocation', () => {
    let current = { ...capabilities }
    const resolved = resolvePlugins([manifest()], () => current)
    if (!resolved.ok) throw new Error(JSON.stringify(resolved))
    const prepared = prepareGeneration(resolved, { authority: createGenerationAuthority(), in_flight: [] })
    prepared.register('observer', 'observer.observe', {})
    current = { ...current, now: 101 }
    expect(() => prepared.activate()).toThrow(/QUALIFICATION_MISSING/)
    current = { ...current, now: 10 }
    prepared.activate()
    const port = prepared.port('observer.observe')
    current = { ...current, permissions: [] }
    expect(() => port.invoke(() => 1)).toThrow(/PERMISSION_MISSING/)
  })
})

describe('snapshot and invocation checkpoints', () => {
  it('captures config data and validator consistently instead of retaining mutable declarations', () => {
    const m = manifest()
    m.config = { nested: { enabled: true } }
    m.config_schema = { validate: value => (value as { nested: { enabled: boolean } }).nested.enabled }
    const resolved = graph([m])
    ;(m.config as { nested: { enabled: boolean } }).nested.enabled = false
    m.config_schema.validate = () => false
    expect(resolved.checkAdmission()).toBeUndefined()
    expect(() => { (resolved.manifests[0]!.config as { nested: { enabled: boolean } }).nested.enabled = false }).toThrow()
    expect(() => { resolved.manifests[0]!.config_schema.validate = () => true }).toThrow()
    expect(Object.isFrozen(resolved.manifests[0]!.permission_requirements)).toBe(true)
    expect(Object.isFrozen(resolved.manifests[0]!.requires)).toBe(true)
    expect(Object.isFrozen(resolved.providers.get('observer.observe'))).toBe(true)
  })
  it('signals drain and blocks a cooperative async side effect after its await', async () => {
    const authority = createGenerationAuthority()
    const old = prepareGeneration(graph(), { authority, in_flight: [] })
    old.register('observer', 'observer.observe', {})
    old.activate()
    let release!: () => void, effects = 0
    const barrier = new Promise<void>(resolve => { release = resolve })
    const pending = old.port('observer.observe').invoke(async (_port, checkpoint) => {
      await barrier
      expect(checkpoint.signal.aborted).toBe(true)
      checkpoint.assertCurrent()
      effects++
    })
    old.beginDrain(20)
    release()
    await expect(pending).rejects.toThrow(/generation/)
    expect(effects).toBe(0)
    expect(old.retire(10, [])).toEqual({ ok: true })
  })
})

it('also holds asynchronous owner-private writes until completion', async () => {
  const authority = createGenerationAuthority()
  const prepared = prepareGeneration(graph(), { authority, in_flight: [] })
  prepared.register('observer', 'observer.observe', {})
  prepared.activate()
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const pending = prepared.writePrivate('observer', 'observer', 'cursor', async () => { await barrier })
  prepared.beginDrain(20)
  expect(prepared.retire(10, [])).toEqual({ ok: false, reason: 'IN_FLIGHT' })
  release()
  await pending
  expect(prepared.retire(10, [])).toEqual({ ok: true })
})

describe('runtime admission follows only declared transitive dependencies', () => {
  it('keeps independent diagnosis live while rejecting a revoked verifier and its dependents', async () => {
    const ms = ['coordinator', 'observer', 'verifier', 'review', 'delivery'].map(id => manifest(id))
    ms[3]!.requires = [{ id: 'verifier.observe', version: '*' }]
    ms[4]!.requires = [{ id: 'review.observe', version: '*' }]
    let caps = { ...capabilities, qualifications: ms.map(m => ({ plugin_id: m.id, version: m.version, evidence_ref: 'test:observer', expires_at: 100 })) }
    const resolved = resolvePlugins(ms, () => caps)
    if (!resolved.ok) throw new Error(JSON.stringify(resolved))
    const generation = prepareGeneration(resolved, { authority: createGenerationAuthority(), in_flight: [] })
    for (const m of ms) generation.register(m.id, m.provides[0]!.id, {})
    generation.activate()
    const saved = generation.port('delivery.observe')
    caps = { ...caps, qualifications: caps.qualifications.filter(q => q.plugin_id !== 'verifier') }
    expect(() => generation.port('verifier.observe').invoke(() => 1)).toThrow('QUALIFICATION_MISSING')
    expect(() => saved.invoke(() => 1)).toThrow('QUALIFICATION_MISSING')
    expect(generation.port('coordinator.observe').invoke(() => 'diagnose and arrange new qualification')).toBe('diagnose and arrange new qualification')
    expect(generation.port('observer.observe').invoke(() => 'query')).toBe('query')
    generation.beginDrain(20)
    expect(generation.retire(10, [])).toEqual({ ok: true })
  })
})
