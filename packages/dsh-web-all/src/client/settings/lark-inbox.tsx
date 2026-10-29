/**
 * 飞书设置页（DSH 0.2）。
 *
 * 位置：设置 → 内置插件 的「飞书」标签页（官方 `settings.plugins.tab`），
 * 只在宿主确实提供 `lark-inbox` 命名空间时才出现（`configForms.whileServed`，
 * 与官方 Agent loop / Subagent 等配置页同一套机制）。
 *
 * 数据：表单走官方 `SettingsFormModel` + `SettingsForm`（staged 编辑、保存时才
 * 落盘、写入带 revision 闸门），凭据仍由连接向导经宿主 loopback 路由写入。
 */
import { type ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  Checkbox,
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  settingsNumberField,
  settingsTextField,
  type SettingsFieldSpec,
  type SettingsFieldState,
  type SettingsFormScope,
  type SettingsFormShell,
} from './primitives-0.2.ts'
import { LarkInboxWizard } from '../lark-inbox/wizard.tsx'
import { makeT, type Translate } from '../lark-inbox/i18n.ts'
import css from './settings-shell.module.css'
import { FAMILY_SETTINGS_NAMESPACE, familyNamespaceScope } from './family-scope.ts'

/** 家族聚合条目在宿主 settings 镜像里的命名空间（host FAMILY_ENTRY_ID）。 */
export { FAMILY_SETTINGS_NAMESPACE }

/** 条目里飞书能力域的子键（host 的 family namespace）。 */
export const LARK_INBOX_NAMESPACE = 'lark-inbox'

/** 面板编辑的字段子集。 */
export interface LarkInboxSettings {
  enabled?: boolean
  announceToAgent?: boolean
  domain?: 'feishu' | 'lark'
  requireMentionInGroup?: boolean
  allowedOpenIds?: string[]
  queueDir?: string
  maxAttempts?: number
  staleTimeoutMs?: number
}

/** 布尔字段：草稿文本用 'true'/'false'，空草稿表示恢复默认。 */
function booleanField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => value === true ? 'true' : value === false ? 'false' : '',
    parse: (text) => {
      if (text === 'true') return { kind: 'set', value: true }
      if (text === 'false') return { kind: 'set', value: false }
      return text === '' ? { kind: 'clear' } : undefined
    },
  }
}

/** 开放 ID 列表：一行一个，也接受逗号/分号分隔。 */
function openIdsField(): SettingsFieldSpec {
  return {
    field: 'allowedOpenIds',
    format: value => Array.isArray(value) ? value.join('\n') : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      return { kind: 'set', value: trimmed.split(/[\n,;]+/u).map(item => item.trim()).filter(Boolean) }
    },
  }
}

/** 设置页投影给组件的状态。 */
interface LarkCardState extends SettingsFormShell {
  enabled: SettingsFieldState
  announceToAgent: SettingsFieldState
  domain: SettingsFieldState
  requireMentionInGroup: SettingsFieldState
  allowedOpenIds: SettingsFieldState
  queueDir: SettingsFieldState
  maxAttempts: SettingsFieldState
  staleTimeoutMs: SettingsFieldState
}

/** 组件读取的 store 面（SnapshotStore 的结构子集）。 */
interface LarkCardStore {
  getSnapshot(): LarkCardState
  subscribe(listener: () => void): () => void
}

/** 页面控制器：把 `lark-inbox` 命名空间桥到官方 staged 表单。 */
export class LarkSettingsController {
  private readonly form: SettingsFormModel<LarkInboxSettings>
  private readonly store: LarkCardStore

  constructor(scope: SettingsFormScope<LarkInboxSettings>) {
    this.form = new SettingsFormModel<LarkInboxSettings>(scope, [
      booleanField('enabled'),
      booleanField('announceToAgent'),
      settingsTextField('domain'),
      booleanField('requireMentionInGroup'),
      openIdsField(),
      settingsTextField('queueDir'),
      settingsNumberField('maxAttempts'),
      settingsNumberField('staleTimeoutMs'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): LarkCardState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      announceToAgent: this.form.field('announceToAgent'),
      domain: this.form.field('domain'),
      requireMentionInGroup: this.form.field('requireMentionInGroup'),
      allowedOpenIds: this.form.field('allowedOpenIds'),
      queueDir: this.form.field('queueDir'),
      maxAttempts: this.form.field('maxAttempts'),
      staleTimeoutMs: this.form.field('staleTimeoutMs'),
    }
  }

  /** 槽注入面：投影 store + 表单动作。 */
  inject(): Record<string, unknown> {
    return { hooks: { larkCard: this.store }, ...this.form.actions() }
  }

  dispose(): void {
    this.form.dispose()
  }
}

interface LarkPageProps {
  view?: 'summary' | 'full'
  useLarkCard<T>(select: (state: LarkCardState) => T): T
  edit(field: string, text: string): void
  resetField(field: string): void
  save(): void
  discard(): void
  t: Translate
}

/** 一个布尔开关行。 */
function BooleanRow({ id, label, hint, field, state, disabled, edit, resetField, t }: {
  id: string
  label: string
  hint: string
  field: 'enabled' | 'announceToAgent' | 'requireMentionInGroup'
  state: LarkCardState
  disabled: boolean
  edit(field: string, text: string): void
  resetField(field: string): void
  t: Translate
}): ReactNode {
  const cell = state[field]
  const checked = cell.text === '' ? false : cell.text === 'true'
  return (
    <div className={css.row} data-dsh-part="field" data-field={field}>
      <div className={css.rowHead}>
        <Checkbox
          checked={checked}
          disabled={disabled}
          label={label}
          onChange={(next) => { edit(field, next ? 'true' : 'false') }}
        />
        {cell.overridden
          ? <button type="button" className={css.reset} disabled={disabled} onClick={() => { resetField(field) }}>{t('settings.reset')}</button>
          : null}
      </div>
      <p className={css.hint} id={id}>{hint}</p>
    </div>
  )
}

/** 未设置该字段表示沿用默认（启用）；显式关闭即不显示连接向导。 */
export function larkWizardVisible(state: Pick<LarkCardState, 'enabled'>): boolean {
  return state.enabled.text === '' ? true : state.enabled.text === 'true'
}

/** 设置标签页主体：连接向导 + 命名空间配置表单。 */
export function LarkSettingsPage(props: LarkPageProps): ReactNode {
  const state = props.useLarkCard(value => value)
  if (props.view === 'summary') return props.t('settings.summary')
  const t = props.t
  const disabled = !state.writable
  // 已关闭的功能不显示连接向导：宿主也会拒绝它的写操作，显示一个必然失败的
  // 向导只会误导用户。
  const enabled = larkWizardVisible(state)
  return (
    <div className={css.page} data-dsh-plugin="lark-inbox" data-dsh-part="settings">
      <h3 className={css.title}>{t('settings.title')}</h3>
      <p className={css.intro}>{t('settings.intro')}</p>
      {enabled ? <LarkInboxWizard t={t}/> : null}
      <SettingsForm
        labels={{
          unavailable: t('settings.unavailable'),
          readOnly: t('settings.readOnly'),
          saveFailed: t('settings.saveFailed'),
          save: t('settings.save'),
          saving: t('settings.saving'),
        }}
        state={state}
        onSave={props.save}
        onDiscard={props.discard}
      >
        <BooleanRow id="lark-enabled-hint" label={t('settings.enabled')} hint={t('settings.enabledHint')} field="enabled" state={state} disabled={disabled} edit={props.edit} resetField={props.resetField} t={t}/>
        <BooleanRow id="lark-announce-hint" label={t('settings.announce')} hint={t('settings.announceHint')} field="announceToAgent" state={state} disabled={disabled} edit={props.edit} resetField={props.resetField} t={t}/>
        <SettingsValueField
          id="lark-domain"
          label={t('settings.domain')}
          hint={t('settings.domainHint')}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalid')}
          disabled={disabled}
          {...state.domain}
          onEdit={(text) => { props.edit('domain', text) }}
          onReset={() => { props.resetField('domain') }}
        />
        <BooleanRow id="lark-mention-hint" label={t('settings.requireMention')} hint={t('settings.requireMentionHint')} field="requireMentionInGroup" state={state} disabled={disabled} edit={props.edit} resetField={props.resetField} t={t}/>
        <SettingsValueField
          id="lark-open-ids"
          label={t('settings.allowedOpenIds')}
          hint={t('settings.allowedOpenIdsHint')}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalid')}
          disabled={disabled}
          {...state.allowedOpenIds}
          onEdit={(text) => { props.edit('allowedOpenIds', text) }}
          onReset={() => { props.resetField('allowedOpenIds') }}
        />
        <SettingsValueField
          id="lark-queue-dir"
          label={t('settings.queueDir')}
          hint={t('settings.queueDirHint')}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalid')}
          disabled={disabled}
          {...state.queueDir}
          onEdit={(text) => { props.edit('queueDir', text) }}
          onReset={() => { props.resetField('queueDir') }}
        />
        <SettingsValueField
          id="lark-max-attempts"
          label={t('settings.maxAttempts')}
          hint={t('settings.maxAttemptsHint')}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalidNumber')}
          numeric
          disabled={disabled}
          {...state.maxAttempts}
          onEdit={(text) => { props.edit('maxAttempts', text) }}
          onReset={() => { props.resetField('maxAttempts') }}
        />
        <SettingsValueField
          id="lark-stale-timeout"
          label={t('settings.staleTimeout')}
          hint={t('settings.staleTimeoutHint')}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalidNumber')}
          numeric
          disabled={disabled}
          {...state.staleTimeoutMs}
          onEdit={(text) => { props.edit('staleTimeoutMs', text) }}
          onReset={() => { props.resetField('staleTimeoutMs') }}
        />
      </SettingsForm>
    </div>
  )
}

/** 官方 configForms 服务的结构面（未装载设置界面时整页不注册）。 */
interface ConfigFormsFace {
  get(entryId: string): SettingsFormScope<Record<string, unknown>>
  whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void
}

function optionalConfigForms(ctx: ClientContext): ConfigFormsFace | undefined {
  try { return (ctx.get as unknown as (id: string, strict?: boolean) => unknown)('configForms', false) as ConfigFormsFace | undefined } catch { return undefined }
}

/**
 * 把 `web-all` 条目的读写面收窄到 `lark-inbox` 子键。
 *
 * 前缀适配的实现在 `family-scope.ts`，与其它能力域共用。
 */
export function larkInboxScope(entry: SettingsFormScope<Record<string, unknown>>): SettingsFormScope<LarkInboxSettings> {
  return familyNamespaceScope<LarkInboxSettings>(entry, LARK_INBOX_NAMESPACE)
}

/** 注册「内置插件 → 飞书」标签页；宿主不再提供该命名空间时自动撤下。 */
export function mountLarkSettings(ctx: ClientContext): () => void {
  const configForms = optionalConfigForms(ctx)
  if (configForms === undefined) return () => {}
  const t = makeT()
  const controller = new LarkSettingsController(larkInboxScope(configForms.get(FAMILY_SETTINGS_NAMESPACE)))
  const offPage = configForms.whileServed([FAMILY_SETTINGS_NAMESPACE], () => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: LARK_INBOX_NAMESPACE,
    order: 60,
    label: () => t('settings.tab'),
    inject: () => ({ ...controller.inject(), t }),
  } as never, LarkSettingsPage as never) as unknown as () => void))
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    offPage()
    controller.dispose()
  }
}