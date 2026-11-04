/**
 * 飞书设置页（DSH 0.2）。
 *
 * 位置：设置 → 内置插件 的「飞书」标签页（官方 `settings.plugins.tab`），
 * 只在宿主确实提供 `lark-inbox` 命名空间时才出现（`configForms.whileServed`，
 * 与官方 Agent loop / Subagent 等配置页同一套机制）。
 *
 * 页面有两个命名空间、两段表单：
 *
 * - 「接入行为」编辑 `lark-inbox`（准入规则、队列、重试），沿用官方
 *   `SettingsFormModel` + `SettingsForm` 的 staged 编辑与 revision 闸门；
 * - 「应用凭据」编辑共享的 `feishu` 命名空间，也就是同一个 bot 服务入站收件箱、
 *   回复与运行结束推送时使用的那套 `appId` / `appSecret` / `domain`。
 *
 * 两个命名空间各自有修订号，所以是两个独立的 `SettingsForm`（各自的保存与放弃），
 * 而不是硬塞进一张表单：把 `feishu` 的写操作挂在 `lark-inbox` 的表单上会让一次
 * 保存横跨两个修订闸门。
 *
 * `appSecret` 是只写字段：宿主读出口把 `role('secret')` 字段剥掉，客户端永远拿
 * 不到它的值，因此输入框恒为空、不显示「当前密钥」、也不给假的占位值。空草稿表示
 * 保持不变，只有非空草稿才会覆盖——这条语义由 `SettingsFormModel` 的只写字段通道
 * 保证，见 `settingsSecretField`。
 */
import { type ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import {
  Checkbox,
  SettingsForm,
  SettingsFormModel,
  SettingsSecretField,
  SettingsValueField,
  settingsNumberField,
  settingsSecretField,
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

/** 条目里飞书入站能力域的子键（host 的 family namespace）。 */
export const LARK_INBOX_NAMESPACE = 'lark-inbox'

/** 共享飞书应用凭据在条目里的子键（host 的 family namespace）。 */
export const FEISHU_NAMESPACE = 'feishu'

/** 「接入行为」表单编辑的字段子集。 */
export const LARK_INBOX_FIELDS = [
  'enabled',
  'announceToAgent',
  'domain',
  'requireMentionInGroup',
  'dropAppMessages',
  'allowedOpenIds',
  'queueDir',
  'maxAttempts',
  'staleTimeoutMs',
  'autoReplyMode',
  'autoReplyOpenIds',
  'autoReplyCwd',
  'autoReplyPreamble',
  'retentionDays',
  'autoReplyReceipt',
  'autoReplySteer',
  'autoReplyRouter',
  'proactiveNotice',
] as const

export type LarkInboxField = (typeof LARK_INBOX_FIELDS)[number]

/**
 * 「应用凭据」表单编辑的字段子集。
 *
 * `appSecret` 只写：它出现在这份清单里只为了被投影成空草稿的控件，写操作走
 * `settingsSecretField` 的通道，不经过路径写入。
 */
export const FEISHU_CREDENTIAL_FIELDS = ['appId', 'appSecret', 'domain'] as const

export type FeishuCredentialField = (typeof FEISHU_CREDENTIAL_FIELDS)[number]

/** 面板编辑的字段子集。 */
export interface LarkInboxSettings {
  enabled?: boolean
  announceToAgent?: boolean
  /** 旧 `lark-inbox` 命名空间里的兼容域名，仅当凭据来自旧字段时生效。 */
  domain?: 'feishu' | 'lark'
  requireMentionInGroup?: boolean
  allowedOpenIds?: string[]
  dropAppMessages?: boolean
  queueDir?: string
  maxAttempts?: number
  staleTimeoutMs?: number
  autoReplyMode?: 'off' | 'probe' | 'self'
  autoReplyOpenIds?: string[]
  autoReplyCwd?: string
  autoReplyPreamble?: string
  retentionDays?: number
  autoReplyReceipt?: boolean
  /** 运行中插话：off 等下一轮、shadow 只记日志、on 真的并进当前回合。 */
  autoReplySteer?: 'off' | 'shadow' | 'on'
  /** 会话自己决定怎么回：off 保持固定形状、on 允许模型选正文或 ACK。 */
  autoReplyRouter?: 'off' | 'on'
  proactiveNotice?: boolean
}

/** 共享 `feishu` 命名空间的字段子集。 */
export interface FeishuCredentialSettings {
  appId?: string
  appSecret?: string
  domain?: 'feishu' | 'lark'
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

/**
 * 自动回话的允许名单：一行一个，也接受逗号/分号分隔。
 *
 * 与 `allowedOpenIds` 分开，因为两者是两件事：那个决定"谁能进入队列、供 agent
 * 读取"，这个决定"谁能得到一个回合的回复"。合成一个会让收紧收件箱时顺手改掉
 * 回话范围，反之亦然。
 */
function autoReplyOpenIdsField(): SettingsFieldSpec {
  return {
    field: 'autoReplyOpenIds',
    format: value => Array.isArray(value) ? value.join('\n') : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      return { kind: 'set', value: trimmed.split(/[\n,;]+/u).map(item => item.trim()).filter(Boolean) }
    },
  }
}

/** 「接入行为」表单投影给组件的状态。 */
type LarkCardState = SettingsFormShell & Record<LarkInboxField, SettingsFieldState>

/** 「应用凭据」表单投影给组件的状态。 */
type FeishuCardState = SettingsFormShell & Record<FeishuCredentialField, SettingsFieldState>

/** 组件读取的 store 面（SnapshotStore 的结构子集）。 */
interface LarkCardStore {
  getSnapshot(): LarkCardState
  subscribe(listener: () => void): () => void
}

/** 凭据表单的 store 面。 */
interface FeishuCardStore {
  getSnapshot(): FeishuCardState
  subscribe(listener: () => void): () => void
}

/** 页面控制器要桥接的两个命名空间读写面。 */
export interface LarkSettingsScopes {
  /** 「接入行为」所在的 `lark-inbox` 命名空间。 */
  inbox: SettingsFormScope<LarkInboxSettings>
  /** 共享应用凭据所在的 `feishu` 命名空间。 */
  credentials: SettingsFormScope<FeishuCredentialSettings>
}

/** 页面控制器：把 `lark-inbox` 与 `feishu` 两个命名空间桥到官方 staged 表单。 */
export class LarkSettingsController {
  private readonly form: SettingsFormModel<LarkInboxSettings>
  private readonly credentialForm: SettingsFormModel<FeishuCredentialSettings>
  private readonly store: LarkCardStore
  private readonly credentialStore: FeishuCardStore

  constructor(scopes: LarkSettingsScopes) {
    this.form = new SettingsFormModel<LarkInboxSettings>(scopes.inbox, [
      booleanField('enabled'),
      booleanField('announceToAgent'),
      settingsTextField('domain'),
      booleanField('requireMentionInGroup'),
      booleanField('dropAppMessages'),
      openIdsField(),
      settingsTextField('queueDir'),
      settingsNumberField('maxAttempts'),
      settingsNumberField('staleTimeoutMs'),
      settingsTextField('autoReplyMode'),
      autoReplyOpenIdsField(),
      settingsTextField('autoReplyCwd'),
      settingsTextField('autoReplyPreamble'),
      settingsNumberField('retentionDays'),
      booleanField('autoReplyReceipt'),
      settingsTextField('autoReplySteer'),
      settingsTextField('autoReplyRouter'),
      booleanField('proactiveNotice'),
    ])
    this.credentialForm = new SettingsFormModel<FeishuCredentialSettings>(scopes.credentials, [
      settingsTextField('appId'),
      settingsTextField('domain'),
    ], [
      // 只写通道：空草稿不写，非空草稿把字面值写进 `feishu.appSecret`。模型不会
      // 把该值投影回控件，所以密钥既不会回显也不会进入页面状态。
      settingsSecretField('appSecret', value => scopes.credentials.mutate([{ op: 'set', path: ['appSecret'], value }])),
    ])
    this.store = this.form.bind(() => this.projection())
    this.credentialStore = this.credentialForm.bind(() => this.credentialProjection())
  }

  private projection(): LarkCardState {
    const fields = Object.fromEntries(LARK_INBOX_FIELDS.map(field => [field, this.form.field(field)])) as Record<LarkInboxField, SettingsFieldState>
    return { ...this.form.shell(), ...fields }
  }

  private credentialProjection(): FeishuCardState {
    const fields = Object.fromEntries(FEISHU_CREDENTIAL_FIELDS.map(field => [field, this.credentialForm.field(field)])) as Record<FeishuCredentialField, SettingsFieldState>
    return { ...this.credentialForm.shell(), ...fields }
  }

  /** 槽注入面：两个投影 store + 两套表单动作。 */
  inject(): Record<string, unknown> {
    const credentials = this.credentialForm.actions()
    return {
      hooks: { larkCard: this.store, larkCredentials: this.credentialStore },
      ...this.form.actions(),
      credentialEdit: credentials.edit,
      credentialResetField: credentials.resetField,
      credentialSave: credentials.save,
      credentialDiscard: credentials.discard,
    }
  }

  dispose(): void {
    this.form.dispose()
    this.credentialForm.dispose()
  }
}

interface LarkPageProps {
  view?: 'summary' | 'full'
  useLarkCard<T>(select: (state: LarkCardState) => T): T
  useLarkCredentials<T>(select: (state: FeishuCardState) => T): T
  edit(field: string, text: string): void
  resetField(field: string): void
  save(): void
  discard(): void
  credentialEdit(field: string, text: string): void
  credentialResetField(field: string): void
  credentialSave(): void
  credentialDiscard(): void
  t: Translate
}

/** 一个布尔开关行。 */
function BooleanRow({ id, label, hint, field, state, disabled, edit, resetField, t }: {
  id: string
  label: string
  hint: string
  field: 'enabled' | 'announceToAgent' | 'requireMentionInGroup' | 'dropAppMessages'
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

/** 设置标签页主体：连接向导 + 接入行为表单 + 应用凭据表单。 */
export function LarkSettingsPage(props: LarkPageProps): ReactNode {
  const state = props.useLarkCard(value => value)
  const credentials = props.useLarkCredentials(value => value)
  if (props.view === 'summary') return props.t('settings.summary')
  const t = props.t
  const disabled = !state.writable
  const credentialDisabled = !credentials.writable
  // 已关闭的功能不显示连接向导：宿主也会拒绝它的写操作，显示一个必然失败的
  // 向导只会误导用户。
  const enabled = larkWizardVisible(state)
  const formLabels = {
    unavailable: t('settings.unavailable'),
    readOnly: t('settings.readOnly'),
    saveFailed: t('settings.saveFailed'),
    save: t('settings.save'),
    saving: t('settings.saving'),
  }
  return (
    <div className={css.page} data-dsh-plugin="lark-inbox" data-dsh-part="settings">
      <h3 className={css.title}>{t('settings.title')}</h3>
      <p className={css.intro}>{t('settings.intro')}</p>
      {enabled ? <LarkInboxWizard t={t}/> : null}
      <SettingsForm
        labels={formLabels}
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
        <BooleanRow id="lark-drop-app-hint" label={t('settings.dropAppMessages')} hint={t('settings.dropAppMessagesHint')} field="dropAppMessages" state={state} disabled={disabled} edit={props.edit} resetField={props.resetField} t={t}/>
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
        <SettingsValueField
          id="lark-auto-reply-mode"
          label={t('settings.autoReplyMode')}
          hint={t('settings.autoReplyModeHint')}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalid')}
          disabled={disabled}
          {...state.autoReplyMode}
          onEdit={(text) => { props.edit('autoReplyMode', text) }}
          onReset={() => { props.resetField('autoReplyMode') }}
        />
        <SettingsValueField
          id="lark-auto-reply-open-ids"
          label={t('settings.autoReplyOpenIds')}
          hint={t('settings.autoReplyOpenIdsHint')}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalid')}
          disabled={disabled}
          {...state.autoReplyOpenIds}
          onEdit={(text) => { props.edit('autoReplyOpenIds', text) }}
          onReset={() => { props.resetField('autoReplyOpenIds') }}
        />
        <SettingsValueField
          id="lark-auto-reply-cwd"
          label={t('settings.autoReplyCwd')}
          hint={t('settings.autoReplyCwdHint')}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalid')}
          disabled={disabled}
          {...state.autoReplyCwd}
          onEdit={(text) => { props.edit('autoReplyCwd', text) }}
          onReset={() => { props.resetField('autoReplyCwd') }}
        />
        <SettingsValueField
          id="lark-auto-reply-preamble"
          label={t('settings.autoReplyPreamble')}
          hint={t('settings.autoReplyPreambleHint')}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalid')}
          disabled={disabled}
          {...state.autoReplyPreamble}
          onEdit={(text) => { props.edit('autoReplyPreamble', text) }}
          onReset={() => { props.resetField('autoReplyPreamble') }}
        />
        <SettingsValueField
          id="lark-retention-days"
          label={t('settings.retentionDays')}
          hint={t('settings.retentionDaysHint')}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalidNumber')}
          numeric
          disabled={disabled}
          {...state.retentionDays}
          onEdit={(text) => { props.edit('retentionDays', text) }}
          onReset={() => { props.resetField('retentionDays') }}
        />
        <SettingsValueField
          id="lark-auto-reply-receipt"
          label={t('settings.autoReplyReceipt')}
          hint={t('settings.autoReplyReceiptHint')}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalid')}
          disabled={disabled}
          {...state.autoReplyReceipt}
          onEdit={(text) => { props.edit('autoReplyReceipt', text) }}
          onReset={() => { props.resetField('autoReplyReceipt') }}
        />
        <SettingsValueField
          id="lark-auto-reply-steer"
          label={t('settings.autoReplySteer')}
          hint={t('settings.autoReplySteerHint')}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalid')}
          disabled={disabled}
          {...state.autoReplySteer}
          onEdit={(text) => { props.edit('autoReplySteer', text) }}
          onReset={() => { props.resetField('autoReplySteer') }}
        />
        <SettingsValueField
          id="lark-auto-reply-router"
          label={t('settings.autoReplyRouter')}
          hint={t('settings.autoReplyRouterHint')}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalid')}
          disabled={disabled}
          {...state.autoReplyRouter}
          onEdit={(text) => { props.edit('autoReplyRouter', text) }}
          onReset={() => { props.resetField('autoReplyRouter') }}
        />
        <SettingsValueField
          id="lark-proactive-notice"
          label={t('settings.proactiveNotice')}
          hint={t('settings.proactiveNoticeHint')}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalid')}
          disabled={disabled}
          {...state.proactiveNotice}
          onEdit={(text) => { props.edit('proactiveNotice', text) }}
          onReset={() => { props.resetField('proactiveNotice') }}
        />
      </SettingsForm>
      <h4 className={css.title}>{t('settings.credentialsTitle')}</h4>
      <p className={css.intro}>{t('settings.credentialsIntro')}</p>
      <SettingsForm
        labels={formLabels}
        state={credentials}
        onSave={props.credentialSave}
        onDiscard={props.credentialDiscard}
      >
        <SettingsValueField
          id="feishu-app-id"
          label={t('settings.appId')}
          hint={t('settings.appIdHint')}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalid')}
          disabled={credentialDisabled}
          {...credentials.appId}
          onEdit={(text) => { props.credentialEdit('appId', text) }}
          onReset={() => { props.credentialResetField('appId') }}
        />
        <SettingsSecretField
          id="feishu-app-secret"
          label={t('settings.appSecret')}
          hint={t('settings.appSecretHint')}
          stateLabel={t('settings.appSecretState')}
          // 状态徽标只说「该字段只能写入」，不断言「已配置」：设置作用域的快照里
          // 不含密钥位置信息，而 appSecret 在 schema 上带默认值，describe 侧车的
          // `set` 因此分不出「填过」和「取默认值」。拿不到可信读数就不显示读数。
          configured={false}
          text={credentials.appSecret.text}
          disabled={credentialDisabled}
          onEdit={(text) => { props.credentialEdit('appSecret', text) }}
        />
        <SettingsValueField
          id="feishu-domain"
          label={t('settings.credentialDomain')}
          hint={t('settings.credentialDomainHint')}
          overriddenLabel={t('settings.overridden')}
          resetLabel={t('settings.reset')}
          invalidLabel={t('settings.invalid')}
          disabled={credentialDisabled}
          {...credentials.domain}
          onEdit={(text) => { props.credentialEdit('domain', text) }}
          onReset={() => { props.credentialResetField('domain') }}
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

/**
 * 把 `web-all` 条目的读写面收窄到共享凭据的 `feishu` 子键。
 *
 * 凭据表单用独立作用域，写操作因此落在 `feishu.*` 路径上，不会误写进
 * `lark-inbox` 的兼容字段。
 */
export function feishuCredentialsScope(entry: SettingsFormScope<Record<string, unknown>>): SettingsFormScope<FeishuCredentialSettings> {
  return familyNamespaceScope<FeishuCredentialSettings>(entry, FEISHU_NAMESPACE)
}

/** 注册「内置插件 → 飞书」标签页；宿主不再提供该命名空间时自动撤下。 */
export function mountLarkSettings(ctx: ClientContext): () => void {
  const configForms = optionalConfigForms(ctx)
  if (configForms === undefined) return () => {}
  const t = makeT()
  const entry = configForms.get(FAMILY_SETTINGS_NAMESPACE)
  const controller = new LarkSettingsController({ inbox: larkInboxScope(entry), credentials: feishuCredentialsScope(entry) })
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