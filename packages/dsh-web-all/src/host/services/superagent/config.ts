/**
 * Superagent configuration (T27, N29): keys with the `superagent` prefix inside
 * the existing `lark-inbox` settings namespace, so the settings page and the parity
 * manifest stay as they are.
 *
 * This file imports nothing: the dependency fence treats a root file other than
 * index.ts as unmapped, and an unmapped file may not have edges. The composition
 * root reads the namespace and hands the raw value to `parseSuperagentConfig`.
 * Every malformed value falls back to its safe default: the switch to `responder`.
 */

export const SUPERAGENT_MODES = ['responder', 'shadow', 'superagent'] as const
export type SuperagentMode = (typeof SUPERAGENT_MODES)[number]

export interface SuperagentDeskConfig {
  seatDir?: string
  preset?: string
  /** Empty: the global default model (N20). */
  model?: { provider: string; model: string; effort?: string }
}

export interface SuperagentWorldConfig {
  entities: unknown[]
  mandates: unknown[]
  owners: { union_id: string; name: string }[]
  colleagues: { union_id: string; name: string }[]
}

export interface SuperagentAttentionConfig {
  interruptQuota: number
  quiet: { from: string; to: string }
  briefAt: string
}

export interface SuperagentConfig {
  superagentMode: SuperagentMode
  superagentDesk: SuperagentDeskConfig
  superagentWorld: SuperagentWorldConfig
  superagentAttention: SuperagentAttentionConfig
}

export const DEFAULT_SUPERAGENT_CONFIG: SuperagentConfig = Object.freeze({
  superagentMode: 'responder',
  superagentDesk: {},
  superagentWorld: { entities: [], mandates: [], owners: [], colleagues: [] },
  superagentAttention: { interruptQuota: 3, quiet: { from: '22:00', to: '08:00' }, briefAt: '18:30' },
}) as SuperagentConfig

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

function people(raw: unknown): { union_id: string; name: string }[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(p => {
    if (!isObject(p)) return []
    const id = str(p.union_id)
    return id ? [{ union_id: id, name: str(p.name) ?? id }] : []
  })
}

function desk(raw: unknown): SuperagentDeskConfig {
  if (!isObject(raw)) return {}
  const out: SuperagentDeskConfig = {}
  const seatDir = str(raw.seatDir)
  const preset = str(raw.preset)
  if (seatDir) out.seatDir = seatDir
  if (preset) out.preset = preset
  if (isObject(raw.model)) {
    const provider = str(raw.model.provider)
    const model = str(raw.model.model)
    const effort = str(raw.model.effort)
    // Both halves or nothing: half a model would silently pick a provider's default.
    if (provider && model) out.model = effort ? { provider, model, effort } : { provider, model }
  }
  return out
}

function attention(raw: unknown): SuperagentAttentionConfig {
  const d = DEFAULT_SUPERAGENT_CONFIG.superagentAttention
  if (!isObject(raw)) return { ...d, quiet: { ...d.quiet } }
  const quota = typeof raw.interruptQuota === 'number' && Number.isInteger(raw.interruptQuota) && raw.interruptQuota >= 0 ? raw.interruptQuota : d.interruptQuota
  const q = isObject(raw.quiet) ? raw.quiet : {}
  const from = typeof q.from === 'string' && HHMM.test(q.from) ? q.from : d.quiet.from
  const to = typeof q.to === 'string' && HHMM.test(q.to) ? q.to : d.quiet.to
  const briefAt = typeof raw.briefAt === 'string' && HHMM.test(raw.briefAt) ? raw.briefAt : d.briefAt
  return { interruptQuota: quota, quiet: { from, to }, briefAt }
}

/** Read the superagent keys out of the `lark-inbox` namespace value. */
export function parseSuperagentConfig(namespace: unknown): SuperagentConfig {
  const ns = isObject(namespace) ? namespace : {}
  const mode = (SUPERAGENT_MODES as readonly unknown[]).includes(ns.superagentMode) ? ns.superagentMode as SuperagentMode : 'responder'
  const world = isObject(ns.superagentWorld) ? ns.superagentWorld : {}
  return {
    superagentMode: mode,
    superagentDesk: desk(ns.superagentDesk),
    superagentWorld: {
      entities: Array.isArray(world.entities) ? [...world.entities] : [],
      mandates: Array.isArray(world.mandates) ? [...world.mandates] : [],
      owners: people(world.owners),
      colleagues: people(world.colleagues),
    },
    superagentAttention: attention(ns.superagentAttention),
  }
}
