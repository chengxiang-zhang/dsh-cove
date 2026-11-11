import type { CapabilitySource, PluginManifest, Rejection, ResolvedGraph } from './contracts'

/** Deliberately restricted version grammar: exact, *, or same-major ^x.y.z. */
export function versionMatches(version: string, range: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false
  if (range === '*') return true
  if (range === version) return true
  if (!/^\^\d+\.\d+\.\d+$/.test(range)) return false
  const actual = version.split('.').map(Number), base = range.slice(1).split('.').map(Number)
  if (actual[0] !== base[0]) return false
  if (base[0] === 0 && actual[1] !== base[1]) return false
  if (base[0] === 0 && base[1] === 0) return version === range.slice(1)
  return actual[1]! > base[1]! || (actual[1] === base[1] && actual[2]! >= base[2]!)
}
function freezeData(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || seen.has(value)) throw new Error('configuration must be acyclic plain data')
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('configuration must be plain data')
  seen.add(value)
  const result = Array.isArray(value)
    ? value.map(item => freezeData(item, seen))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeData(item, seen)]))
  seen.delete(value)
  return Object.freeze(result)
}
function snapshot(m: PluginManifest): PluginManifest {
  const validate = m.config_schema.validate
  return Object.freeze({
    ...m,
    config: freezeData(m.config),
    config_schema: Object.freeze({ validate: (value: unknown) => validate(value) }),
    provides: Object.freeze(m.provides.map(p => Object.freeze({ ...p }))),
    requires: Object.freeze(m.requires.map(p => Object.freeze({ ...p }))),
    owned_state_schemas: Object.freeze(m.owned_state_schemas.map(s => Object.freeze({ ...s }))),
    compatible_schema_versions: Object.freeze([...m.compatible_schema_versions]),
    migration_refs: Object.freeze([...m.migration_refs]),
    permission_requirements: Object.freeze([...m.permission_requirements]),
    required_extensions: Object.freeze([...m.required_extensions]),
    contract_test_refs: Object.freeze([...m.contract_test_refs]),
  })
}
/** A facade rather than Object.freeze(Map), which leaves Map.set operational. */
function readOnlyMap<K, V>(map: Map<K, V>): ReadonlyMap<K, V> {
  const view: ReadonlyMap<K, V> = Object.freeze({
    get size() { return map.size },
    get: (key: K) => map.get(key),
    has: (key: K) => map.has(key),
    keys: () => map.keys(),
    values: () => map.values(),
    entries: () => map.entries(),
    [Symbol.iterator]: () => map[Symbol.iterator](),
    forEach(callback: (value: V, key: K, source: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
      map.forEach((value, key) => callback.call(thisArg, value, key, view))
    },
  })
  return view
}
export function resolvePlugins(input: readonly PluginManifest[], source: CapabilitySource): ResolvedGraph | Rejection {
  let manifests: readonly PluginManifest[]
  try { manifests = Object.freeze(input.map(snapshot)) }
  catch { return { ok: false, code: 'CONFIG_INVALID', plugin_id: '', subject: 'snapshot' } }
  return resolveSnapshot(manifests, source)
}
function resolveSnapshot(manifests: readonly PluginManifest[], source: CapabilitySource): ResolvedGraph | Rejection {
  const caps = typeof source === 'function' ? source() : source
  const reject = (code: string, plugin_id: string, subject: string): Rejection => ({ ok: false, code, plugin_id, subject })
  const ids = new Set<string>(), namespaces = new Set<string>()
  const providers = new Map<string, { plugin_id: string; version: string; contract: string }>()
  for (const m of manifests) {
    if (!m.id || !m.namespace || ids.has(m.id) || namespaces.has(m.namespace)) return reject('IDENTITY_CONFLICT', m.id, m.namespace)
    ids.add(m.id); namespaces.add(m.namespace)
    if (!versionMatches(m.version, m.version)) return reject('VERSION_INVALID', m.id, m.version)
    if (!versionMatches(caps.contract_version, m.contract_version)) return reject('CONTRACT_INCOMPATIBLE', m.id, m.contract_version)
    for (const p of m.provides) {
      if (providers.has(p.id)) return reject('PORT_CONFLICT', m.id, p.id)
      if (!versionMatches(p.version, p.version)) return reject('VERSION_INVALID', m.id, p.id)
      providers.set(p.id, Object.freeze({ plugin_id: m.id, version: p.version, contract: p.contract ?? p.id }))
    }
  }
  for (const m of manifests) for (const r of m.requires) {
    const p = providers.get(r.id)
    if (!p) return reject('DEPENDENCY_MISSING', m.id, r.id)
    if (p.contract !== (r.contract ?? r.id)) return reject('PORT_CONTRACT_INCOMPATIBLE', m.id, r.id)
    if (!versionMatches(p.version, r.version)) return reject('PORT_VERSION_INCOMPATIBLE', m.id, r.id)
  }
  const order: string[] = [], visited = new Set<string>(), visiting = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false
    if (visited.has(id)) return true
    visiting.add(id)
    const m = manifests.find(value => value.id === id)!
    for (const r of m.requires) if (!visit(providers.get(r.id)!.plugin_id)) return false
    visiting.delete(id); visited.add(id); order.push(id)
    return true
  }
  for (const m of manifests) if (!visit(m.id)) return reject('DEPENDENCY_CYCLE', m.id, [...visiting].join(' -> '))
  for (const m of manifests) {
    let valid = false
    try { valid = m.config_schema.validate(m.config) } catch { /* fail closed */ }
    if (!valid) return reject('CONFIG_INVALID', m.id, 'config')
    if (!m.compatible_schema_versions.some(v => caps.schema_versions.includes(v))) return reject('SCHEMA_INCOMPATIBLE', m.id, 'schema')
    for (const e of m.required_extensions) if (!caps.extensions.includes(e)) return reject('EXTENSION_MISSING', m.id, e)
    for (const p of m.permission_requirements) if (!caps.permissions.includes(p)) return reject('PERMISSION_MISSING', m.id, p)
    if (!caps.isolated_modes.includes(m.isolation_mode)) return reject('ISOLATION_UNAVAILABLE', m.id, m.isolation_mode)
    if (!m.contract_test_refs.length || !caps.qualifications.some(q => q.plugin_id === m.id && q.version === m.version && q.expires_at > caps.now && m.contract_test_refs.includes(q.evidence_ref))) {
      return reject('QUALIFICATION_MISSING', m.id, m.version)
    }
  }
  return Object.freeze({
    ok: true as const,
    order: Object.freeze(order),
    manifests,
    providers: readOnlyMap(providers),
    checkAdmission(pluginId?: string) {
      const selected = new Set<string>()
      const include = (id: string): void => {
        if (selected.has(id)) return
        selected.add(id)
        for (const r of manifests.find(m => m.id === id)!.requires) include(providers.get(r.id)!.plugin_id)
      }
      if (pluginId !== undefined && !ids.has(pluginId)) return reject('PLUGIN_UNKNOWN', pluginId, pluginId)
      if (pluginId !== undefined) include(pluginId)
      const checked = resolveSnapshot(pluginId === undefined ? manifests : manifests.filter(m => selected.has(m.id)), source)
      return checked.ok ? undefined : checked
    },
  })
}
