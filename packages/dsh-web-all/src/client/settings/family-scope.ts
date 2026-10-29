/**
 * 家族设置作用域：把 `web-all` 聚合条目的读写面收窄到一个能力域命名空间。
 *
 * DSH 0.2 的客户端设置面按命名空间寻址，而家族的全部能力域聚合在单个 `web-all`
 * 条目里（顶层 volatile 子键就是能力域，见 host 的 `family-config.ts`）。这里做
 * 一次路径前缀适配：读侧下钻子对象，写侧给每个路径加上子键前缀，于是官方
 * `SettingsFormModel` / `SettingsForm` 的 staged 编辑、保存与 revision 闸门都能
 * 原样复用，每个能力域不必各自实现一遍。
 *
 * 该适配只做路径搬运，不解释值：字段的格式化与校验仍由各页自己的 `SettingsFieldSpec`
 * 负责。
 */
import type { SettingsFormScope, SettingsFormScopeSnapshot } from './primitives-0.2.ts'

/** 家族聚合条目在宿主 settings 镜像里的条目 id（host 的 `FAMILY_ENTRY_ID`）。 */
export const FAMILY_SETTINGS_NAMESPACE = 'web-all'

/**
 * 把聚合条目的作用域收窄到一个命名空间。
 * @param entry - `configForms.get('web-all')` 返回的聚合读写面。
 * @param namespace - 能力域在条目里的子键。
 * @returns 只读写该命名空间的等价作用域。
 */
export function familyNamespaceScope<T>(entry: SettingsFormScope<Record<string, unknown>>, namespace: string): SettingsFormScope<T> {
  const section = (snapshot: SettingsFormScopeSnapshot<Record<string, unknown>>): SettingsFormScopeSnapshot<T> => {
    const value = snapshot.value as Record<string, unknown> | undefined
    const base = snapshot.base as Record<string, unknown> | undefined
    const user = snapshot.user as Record<string, unknown> | undefined
    return {
      status: snapshot.status,
      value: value?.[namespace] as T | undefined,
      base: base?.[namespace],
      user: user?.[namespace],
      writable: snapshot.writable,
      revision: snapshot.revision,
    }
  }
  return {
    getSnapshot: () => section(entry.getSnapshot()),
    subscribe: listener => entry.subscribe(listener),
    mutate: (ops, expectedRevision) => entry.mutate(ops.map((op) => op.op === 'set'
      ? { op: 'set' as const, path: [namespace, ...op.path], value: op.value }
      : { op: 'unset' as const, path: [namespace, ...op.path] }), expectedRevision),
  }
}