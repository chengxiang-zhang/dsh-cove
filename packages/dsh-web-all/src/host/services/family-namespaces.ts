/**
 * 家族设置命名空间注册表。
 *
 * DSH 0.2 取消了 `ctx.settings.register(ns, schema, …)`：设置文档只服务 Loader
 * 条目，字段来自条目运行时导出的 schemastery `Config`。因此全家桶把每个能力域
 * 的设置收敛成 `web-all` 条目 Config 的一个命名空间键。
 *
 * 本文件不 import 任何服务域，避免 `family-config → 服务域 → family-config` 的
 * 循环：服务域在自己的模块顶层登记 schema，装配器在所有服务域 import 求值完成后
 * 用登记表构建聚合 Config（见 family-config.ts 的 createFamilyConfig）。
 */

/** schemastery schema 的最小结构面（登记表只存 JSON，不绑定具体 schema 库实例）。 */
export interface FamilyNamespaceSchema {
  toJSON(): unknown
}

const registry = new Map<string, FamilyNamespaceSchema>()

/** 登记一个命名空间的 schema（同一命名空间只登记一次，后者忽略）。 */
export function registerFamilyNamespace(namespace: string, schema: FamilyNamespaceSchema): void {
  if (registry.has(namespace)) return
  registry.set(namespace, schema)
}

/** 取某命名空间的 schema 对象（未登记返回 undefined）。 */
export function registeredFamilySchema(namespace: string): FamilyNamespaceSchema | undefined {
  return registry.get(namespace)
}

/** 已登记的命名空间（登记顺序）。 */
export function registeredFamilyNamespaces(): string[] {
  return [...registry.keys()]
}