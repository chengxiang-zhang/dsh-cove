/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的 0.2 设置表单原语出口。
 *
 * 本仓 node_modules 里的 SDK cohort 仍是 0.1.5-rc.2（类型里没有 0.2 的
 * `SettingsForm` / `SettingsFormModel` / `Checkbox` 等导出），而运行时由 DSH 0.2
 * 提供这些成员——与 `*Medium` 图标同一类版本差。这里按 0.2 的 d.ts 声明需要的
 * 最小面，并按名取运行时值，既不让本地类型滞后挡住实现，也不改动模块本身。
 */
import type { ReactElement, ReactNode } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

/** 一次字段写入的转换结果。 */
export type SettingsFieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' }

/** 字段在存储值与草稿文本之间的转换规则。 */
export interface SettingsFieldSpec {
  field: string
  format(value: unknown): string
  parse(text: string): SettingsFieldWrite | undefined
}

/** 单个控件的渲染状态。 */
export interface SettingsFieldState {
  /** 控件渲染的草稿文本。 */
  text: string
  /** 保存后该字段是否会在用户层留下覆盖。 */
  overridden: boolean
  /** 草稿是否是本字段接受的值（不接受时阻止保存）。 */
  invalid: boolean
}

/** 每个配置页共享的表单状态。 */
export interface SettingsFormShell {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
}

/** 表单动作面（槽注入用）。 */
export interface SettingsFormActions {
  edit(field: string, text: string): void
  resetField(field: string): void
  save(): void
  discard(): void
}

/** 命名空间快照。 */
export interface SettingsFormScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  base: unknown
  user: unknown
  writable: boolean
  revision: number | undefined
}

/** 一个宿主条目/命名空间的读写面（由 `configForms.get` 返回）。 */
export interface SettingsFormScope<T> {
  getSnapshot(): SettingsFormScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  mutate(ops: readonly SettingsFormPathOp[], expectedRevision?: number): Promise<boolean>
}

/** 一次 revision 闸门内的路径编辑。 */
export type SettingsFormPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

/** staged 表单模型：读侧投影 + 保存时才落盘。 */
export interface SettingsFormModel<T> {
  bind<S>(project: () => S): { getSnapshot(): S; subscribe(listener: () => void): () => void }
  shell(): SettingsFormShell
  field(field: string): SettingsFieldState
  actions(): SettingsFormActions
  save(): Promise<void>
  dispose(): void
}

interface SettingsFormModelCtor {
  new <T>(scope: SettingsFormScope<T>, specs: SettingsFieldSpec[], secrets?: readonly unknown[]): SettingsFormModel<T>
}

/** 值控件的 props。 */
export interface SettingsValueFieldProps {
  id: string
  label: string
  hint?: string
  text: string
  overridden: boolean
  invalid: boolean
  overriddenLabel: string
  resetLabel: string
  invalidLabel: string
  disabled: boolean
  numeric?: boolean
  placeholder?: string
  onEdit(text: string): void
  onReset(): void
}

/** 复选框的 props。 */
export interface CheckboxProps {
  checked: boolean
  onChange(next: boolean): void
  label: string
  disabled?: boolean
  title?: string
  className?: string
}

/** 表单框架文案。 */
export interface SettingsFormLabels {
  unavailable: string
  readOnly: string
  saveFailed: string
  save: string
  saving: string
}

/** 表单框架的 props。 */
export interface SettingsFormProps {
  labels: SettingsFormLabels
  state: SettingsFormShell
  onSave(): void
  onDiscard(): void
  children: ReactNode
}

type Component<P> = (props: P) => ReactElement | null

const table = primitives as unknown as {
  Checkbox: Component<CheckboxProps>
  SettingsForm: Component<SettingsFormProps>
  SettingsFormModel: SettingsFormModelCtor
  SettingsValueField: Component<SettingsValueFieldProps>
  settingsTextField(field: string): SettingsFieldSpec
  settingsNumberField(field: string): SettingsFieldSpec
}

export const Checkbox = table.Checkbox
export const SettingsForm = table.SettingsForm
export const SettingsFormModel = table.SettingsFormModel
export const SettingsValueField = table.SettingsValueField
export const settingsTextField = table.settingsTextField
export const settingsNumberField = table.settingsNumberField