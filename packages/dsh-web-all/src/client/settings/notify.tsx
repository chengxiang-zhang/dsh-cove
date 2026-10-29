/**
 * 通知设置页（DSH 0.2）。
 *
 * 位置：设置 → 内置插件 的「通知」标签页（官方 `settings.plugins.tab`），只在宿主
 * 确实提供 `notify` 命名空间时才出现（`configForms.whileServed`，与「飞书」页同一
 * 套机制）。
 *
 * 数据：表单走官方 `SettingsFormModel` + `SettingsForm`（staged 编辑、保存时才落盘、
 * 写入带 revision 闸门）。凭据字段只写不读：宿主把 appSecret 存进设置文档后不在任何
 * 应答里回显，所以这里不提供「当前密钥」的展示，也不给它一个假的占位值。
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
import { makeT, type Translate } from '../notify/i18n.ts'
import { FAMILY_SETTINGS_NAMESPACE, familyNamespaceScope } from './family-scope.ts'
import css from './settings-shell.module.css'
import { NOTIFY_FEED_PATH } from '../../core/notify/contract.ts'

/** 条目里通知能力域的子键（host 的 family namespace）。 */
export const NOTIFY_NAMESPACE = 'notify'

/** 面板编辑的字段子集。 */
export interface NotifySettings {
  enabled?: boolean
  feedLimit?: number
  feishuEnabled?: boolean
  feishuAppId?: string
  feishuAppSecret?: string
  feishuDomain?: 'feishu' | 'lark'
  feishuRecipients?: string[]
  feishuMode?: 'idle' | 'each-turn'
  feishuOutcomes?: string[]
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

/**
 * 字符串列表字段：一行一个，也接受逗号/分号分隔。
 *
 * 收件人与结果集合共用同一形状，所以共用同一解析：两者的空值语义都是「恢复默认」，
 * 而默认由宿主 schema 决定，客户端不复制一份。
 */
function listField(field: string): SettingsFieldSpec {
  return {
    field,
    format: value => Array.isArray(value) ? value.join('\n') : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      return { kind: 'set', value: trimmed.split(/[\n,;]+/u).map(item => item.trim()).filter(Boolean) }
    },
  }
}

/** 设置页投影给组件的状态。 */
interface NotifyCardState extends SettingsFormShell {
  enabled: SettingsFieldState
  feedLimit: SettingsFieldState
  feishuEnabled: SettingsFieldState
  feishuAppId: SettingsFieldState
  feishuAppSecret: SettingsFieldState
  feishuDomain: SettingsFieldState
  feishuRecipients: SettingsFieldState
  feishuMode: SettingsFieldState
  feishuOutcomes: SettingsFieldState
}

/** 组件读取的 store 面（SnapshotStore 的结构子集）。 */
interface NotifyCardStore {
  getSnapshot(): NotifyCardState
  subscribe(listener: () => void): () => void
}

/** 页面控制器：把 `notify` 命名空间桥到官方 staged 表单。 */
export class NotifySettingsController {
  private readonly form: SettingsFormModel<NotifySettings>
  private readonly store: NotifyCardStore

  constructor(scope: SettingsFormScope<NotifySettings>) {
    this.form = new SettingsFormModel<NotifySettings>(scope, [
      booleanField('enabled'),
      settingsNumberField('feedLimit'),
      booleanField('feishuEnabled'),
      settingsTextField('feishuAppId'),
      settingsTextField('feishuAppSecret'),
      settingsTextField('feishuDomain'),
      listField('feishuRecipients'),
      settingsTextField('feishuMode'),
      listField('feishuOutcomes'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): NotifyCardState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      feedLimit: this.form.field('feedLimit'),
      feishuEnabled: this.form.field('feishuEnabled'),
      feishuAppId: this.form.field('feishuAppId'),
      feishuAppSecret: this.form.field('feishuAppSecret'),
      feishuDomain: this.form.field('feishuDomain'),
      feishuRecipients: this.form.field('feishuRecipients'),
      feishuMode: this.form.field('feishuMode'),
      feishuOutcomes: this.form.field('feishuOutcomes'),
    }
  }

  /** 槽注入面：投影 store + 表单动作。 */
  inject(): Record<string, unknown> {
    return { hooks: { notifyCard: this.store }, ...this.form.actions() }
  }

  dispose(): void {
    this.form.dispose()
  }
}

interface NotifyPageProps {
  view?: 'summary' | 'full'
  useNotifyCard<T>(select: (state: NotifyCardState) => T): T
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
  field: 'enabled' | 'feishuEnabled'
  state: NotifyCardState
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

/** 一个文本/数字字段行。 */
function FieldRow({ id, field, label, hint, state, disabled, numeric, edit, resetField, t }: {
  id: string
  field: keyof NotifySettings & string
  label: string
  hint: string
  state: NotifyCardState
  disabled: boolean
  numeric?: boolean
  edit(field: string, text: string): void
  resetField(field: string): void
  t: Translate
}): ReactNode {
  const cell = state[field as keyof NotifyCardState] as SettingsFieldState
  return (
    <SettingsValueField
      id={id}
      label={label}
      hint={hint}
      overriddenLabel={t('settings.overridden')}
      resetLabel={t('settings.reset')}
      invalidLabel={numeric === true ? t('settings.invalidNumber') : t('settings.invalid')}
      disabled={disabled}
      numeric={numeric}
      {...cell}
      onEdit={(text) => { edit(field, text) }}
      onReset={() => { resetField(field) }}
    />
  )
}

/** 设置标签页主体。 */
export function NotifySettingsPage(props: NotifyPageProps): ReactNode {
  const state = props.useNotifyCard(value => value)
  if (props.view === 'summary') return props.t('settings.summary')
  const t = props.t
  const disabled = !state.writable
  return (
    <div className={css.page} data-dsh-plugin="notify" data-dsh-part="settings">
      <h3 className={css.title}>{t('settings.title')}</h3>
      <p className={css.intro}>{t('settings.intro')}</p>
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
        <BooleanRow id="notify-enabled-hint" label={t('settings.enabled')} hint={t('settings.enabledHint')} field="enabled" state={state} disabled={disabled} edit={props.edit} resetField={props.resetField} t={t}/>
        <FieldRow id="notify-feed-limit" field="feedLimit" label={t('settings.feedLimit')} hint={t('settings.feedLimitHint')} state={state} disabled={disabled} numeric edit={props.edit} resetField={props.resetField} t={t}/>
        <p className={css.hint} data-dsh-part="feed-path">
          {t('settings.feed')}：<code>{NOTIFY_FEED_PATH}</code>
          <br/>
          {t('settings.feedHint')}
        </p>
        <BooleanRow id="notify-feishu-enabled-hint" label={t('settings.feishuEnabled')} hint={t('settings.feishuEnabledHint')} field="feishuEnabled" state={state} disabled={disabled} edit={props.edit} resetField={props.resetField} t={t}/>
        <FieldRow id="notify-feishu-app-id" field="feishuAppId" label={t('settings.feishuAppId')} hint={t('settings.feishuAppIdHint')} state={state} disabled={disabled} edit={props.edit} resetField={props.resetField} t={t}/>
        <FieldRow id="notify-feishu-app-secret" field="feishuAppSecret" label={t('settings.feishuAppSecret')} hint={t('settings.feishuAppSecretHint')} state={state} disabled={disabled} edit={props.edit} resetField={props.resetField} t={t}/>
        <FieldRow id="notify-feishu-domain" field="feishuDomain" label={t('settings.feishuDomain')} hint={t('settings.feishuDomainHint')} state={state} disabled={disabled} edit={props.edit} resetField={props.resetField} t={t}/>
        <FieldRow id="notify-feishu-recipients" field="feishuRecipients" label={t('settings.feishuRecipients')} hint={t('settings.feishuRecipientsHint')} state={state} disabled={disabled} edit={props.edit} resetField={props.resetField} t={t}/>
        <FieldRow id="notify-feishu-mode" field="feishuMode" label={t('settings.feishuMode')} hint={t('settings.feishuModeHint')} state={state} disabled={disabled} edit={props.edit} resetField={props.resetField} t={t}/>
        <FieldRow id="notify-feishu-outcomes" field="feishuOutcomes" label={t('settings.feishuOutcomes')} hint={t('settings.feishuOutcomesHint')} state={state} disabled={disabled} edit={props.edit} resetField={props.resetField} t={t}/>
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

/** 注册「内置插件 → 通知」标签页；宿主不再提供该命名空间时自动撤下。 */
export function mountNotifySettings(ctx: ClientContext): () => void {
  const configForms = optionalConfigForms(ctx)
  if (configForms === undefined) return () => {}
  const t = makeT()
  const controller = new NotifySettingsController(familyNamespaceScope<NotifySettings>(configForms.get(FAMILY_SETTINGS_NAMESPACE), NOTIFY_NAMESPACE))
  const offPage = configForms.whileServed([FAMILY_SETTINGS_NAMESPACE], () => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: NOTIFY_NAMESPACE,
    order: 61,
    label: () => t('settings.tab'),
    inject: () => ({ ...controller.inject(), t }),
  } as never, NotifySettingsPage as never) as unknown as () => void))
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    offPage()
    controller.dispose()
  }
}