/**
 * 家族设置桥：把 `web-all` 条目的 Config 变成 DSH 0.2 原生设置文档的一部分。
 *
 * 背景（0.2 breaking change）：Host `settings` 服务按 **profile 条目 id** 寻址，
 * 只服务带运行时 schemastery `Config`、且至少有一个 `meta.volatile` 节点的条目；
 * 旧的 `settings.register/get/installSection` 全部不存在。全家桶因此把每个能力域
 * 的设置收敛为聚合条目 `web-all` Config 的一个命名空间键：
 *
 *   - 读取：`familyNamespace(ns)` 从 loader 传给 `apply()` 的已解析 config 里解包。
 *   - 写入：`updateFamilyNamespace(ctx, ns, patch)` 走原生 `settings.update('web-all', …)`，
 *     落盘到 profile patch；volatile 节点由 loader 原地热更新（`_commitVolatile`），
 *     不会重挂插件。
 *   - 通知：`onFamilyConfigChange(cb)` 供“注册时读一次”的服务域在变更后重新 sync。
 *
 * volatile 协议：0.2 的 loader/cosmokit 用 `Symbol.for('cosmokit.volatile.write')`
 * 引用对象承载热更新（`updateVolatile(ref, source)` 直接调 `ref[write](source.get())`）。
 * 家族依赖的是社区版 `schemastery`（无 `.volatile()`），因此这里在 schema 上直接标
 * `meta.volatile`，并在 `~standard.validate` 出口把命名空间值包成同协议的引用对象：
 * 与原生 `@deepseek-ai/schemastery` 的产物逐字段等价，且不引入新依赖。
 *
 * 命名空间 schema 由各服务域在自己的模块顶层通过 `registerFamilyNamespace` 登记，
 * 装配器在所有服务域 import 求值完成后再构建本聚合 Config（见 createFamilyConfig）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from 'schemastery'
import { registeredFamilySchema } from './family-namespaces.ts'

// 服务域从本模块导入登记入口，避免它们直接依赖注册表模块。
export { registerFamilyNamespace } from './family-namespaces.ts'

/** 聚合条目 id（与 cordis.patch.yml 的 insert id 一致）。 */
export const FAMILY_ENTRY_ID = 'web-all'

/**
 * 期望存在的命名空间：即使某个服务域被裁剪/未登记，也保证键存在（回退为宽松
 * 任意对象），客户端写入不会因缺键被 Host 拒绝。
 */
export const FAMILY_NAMESPACES = [
  'remote-web-ui',
  'lark-inbox',
  'notify',
  'dsh-ssh',
  'dsh-codex-bridge',
  'workspace-model',
  'web-render',
  'schedule-mode',
] as const

/** 非设置类装配参数（非 volatile：变更即重挂，语义与 0.1 的普通配置一致）。 */
const CORE_FIELDS = {
  dshHome: z.string(),
  agentsHome: z.string(),
  noBrowserAuth: z.boolean().default(false),
  codexProxyDir: z.string(),
  playwright: z.object({
    mode: z.union(['launch', 'extension', 'cdp'] as const).default('launch'),
    cdpEndpoint: z.string().default(''),
    headless: z.boolean().default(true),
    browserChannel: z.union(['chrome', 'msedge'] as const).default('chrome'),
    executablePath: z.string().default(''),
    allowedHosts: z.array(z.string()).default(['*']),
    allowedOrigins: z.array(z.string()).default([]),
    blockedOrigins: z.array(z.string()).default([]),
    approvalPolicy: z.union(['never', 'unsafe', 'mutations'] as const),
    unsafeTools: z.boolean(),
    sessionsRoot: z.string(),
    toolCallTimeoutMs: z.number().step(1).min(1).default(120_000),
    idleTimeoutMs: z.number().step(1).min(0).default(900_000),
    maxConcurrentBrowsers: z.number().step(1).min(1).default(2),
    pruneProfileOnDispose: z.boolean().default(true),
    profileTtlMs: z.number().step(1).min(0).default(86_400_000),
    profileSweepIntervalMs: z.number().step(1).min(0).default(3_600_000),
    liveView: z.boolean().default(false),
  }).default({ mode: 'launch', headless: true, browserChannel: 'chrome', executablePath: '', allowedHosts: ['*'], allowedOrigins: [], blockedOrigins: [], toolCallTimeoutMs: 120_000, idleTimeoutMs: 900_000, maxConcurrentBrowsers: 2, pruneProfileOnDispose: true, profileTtlMs: 86_400_000, profileSweepIntervalMs: 3_600_000, liveView: false }),
  worktree: z.any(),
}

/** cosmokit 的 volatile 引用写入口（跨包用 Symbol.for 对齐）。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

interface VolatileRef {
  get(): unknown
  [VOLATILE_WRITE](next: unknown): void
}

/** 深冻结（JSON 形状），与 cosmokit `createVolatile` 的快照语义一致但更宽容。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

/** 创建一个 loader 可原地更新的 volatile 引用。 */
function volatileRef(initial: unknown): VolatileRef {
  let current = deepFreeze(initial)
  return Object.freeze({
    get: () => current,
    [VOLATILE_WRITE]: (next: unknown) => { current = next },
  }) as VolatileRef
}

interface SchemaNode {
  type?: string
  meta?: Record<string, unknown>
  dict?: Record<string, SchemaNode>
}

/** 按 schema 的 volatile 标记把解析值包成引用（递归到对象字段）。 */
function wrapVolatile(node: SchemaNode, value: unknown): unknown {
  if (node.meta?.volatile === true) return volatileRef(value)
  if (node.type === 'object' && node.dict !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) }
    for (const [key, child] of Object.entries(node.dict)) {
      if (key in out) out[key] = wrapVolatile(child, out[key])
    }
    return out
  }
  return value
}

/** 聚合 Config 的对外类型面：只暴露 loader/settings 真正读取的结构，避免把
 * schemastery 的实现类型泄漏到依赖方（社区版与原生版类型不可互换）。 */
export interface FamilyConfigSchema {
  toJSON(): unknown
  dict?: Record<string, { meta?: Record<string, unknown> }>
  meta?: Record<string, unknown>
  '~standard': { vendor?: string; version?: number; validate(input: unknown): { value?: unknown; issues?: unknown } }
}

/**
 * 构建聚合 Config。必须在所有服务域模块求值完成后调用（装配器模块体内调用）。
 * @returns schemastery schema（即插件运行时 `Config`）。
 */
export function createFamilyConfig(): FamilyConfigSchema {
  const namespaces: Record<string, unknown> = {}
  for (const namespace of FAMILY_NAMESPACES) {
    // 已登记的能力域用自己的 schema（原生设置表单可渲染真实字段）；未登记的回退为
    // 任意对象（写入/读取仍可用，默认值由客户端提供）。
    // 未登记时也必须有默认值：默认值让解析结果始终带 volatile 引用（loader 才能原地热更新）。
    namespaces[namespace] = registeredFamilySchema(namespace) ?? z.any().default({})
  }
  const schema = z.object({ ...CORE_FIELDS, ...namespaces }) as unknown as SchemaNode & {
    '~standard': { vendor?: string; version?: number; validate(input: unknown): { value?: unknown; issues?: unknown } }
  }
  // 命名空间节点标 volatile：settings 表单可见/可写、loader 走热更新路径的前提。
  for (const namespace of FAMILY_NAMESPACES) {
    const node = schema.dict?.[namespace]
    if (node !== undefined) node.meta = { ...(node.meta ?? {}), volatile: true }
  }
  // 校验出口包引用：与原生 @deepseek-ai/schemastery 的 volatile 产物同协议。
  const standard = schema['~standard']
  // 注意：社区 schemastery 的 `~standard` 是原型上的 getter（无 setter），ESM 严格模式
  // 下直接赋值会抛 TypeError；用 defineProperty 建自己的描述符。
  Object.defineProperty(schema, '~standard', {
    configurable: true,
    enumerable: true,
    value: {
      vendor: standard.vendor,
      version: standard.version,
      validate: (input: unknown) => {
        const result = standard.validate(input)
        if (result.issues !== undefined) return result
        return { value: wrapVolatile(schema as SchemaNode, result.value) }
      },
    },
  })
  return schema as unknown as FamilyConfigSchema
}

/** loader 解析后的聚合 config（volatile 节点是 `{ get() }` 引用）。 */
let bound: Record<string, unknown> | undefined

/** 解包 volatile 引用（非引用原样返回）。 */
function unwrap(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get: () => unknown }).get()
  }
  return value
}

/** 绑定 loader 传入的 config（`apply()` 首行调用）。 */
export function bindFamilyConfig(config: unknown): void {
  bound = config === null || typeof config !== 'object' ? undefined : config as Record<string, unknown>
}

/** 读取某命名空间当前值（不存在返回 undefined；volatile 引用实时解包）。 */
export function familyNamespace<T>(namespace: string): T | undefined {
  const value = unwrap(bound?.[namespace])
  return value !== null && typeof value === 'object' ? value as T : undefined
}

/**
 * 写入某命名空间（原生设置文档，profile patch）。
 * @param ctx - host 插件上下文（需要 `settings` 服务）。
 * @param namespace - 命名空间键。
 * @param patch - 要合并的字段。
 */
export async function updateFamilyNamespace(ctx: Context, namespace: string, patch: Record<string, unknown>): Promise<void> {
  const settings = (ctx as unknown as { settings?: { update?: (ns: string, patch: unknown) => Promise<void> } }).settings
  if (typeof settings?.update !== 'function') throw new Error('dsh-web-all: settings service unavailable (0.2 requires the web-all entry Config)')
  await settings.update(FAMILY_ENTRY_ID, { [namespace]: patch })
}

const listeners = new Set<() => void>()

/** 订阅聚合配置变更（返回 disposer）。 */
export function onFamilyConfigChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Host 侧 loader/settings 事件到达时广播（由插件入口装配）。 */
export function notifyFamilyConfigChange(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.warn('[web-all:settings] change listener failed:', error)
    }
  }
}
