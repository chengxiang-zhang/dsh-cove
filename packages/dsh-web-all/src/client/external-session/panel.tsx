/**
 * 外援会话右侧面板（设计稿 §11.2）。
 *
 * 一个面板两段：上面是会话列表（provider / 标题 / 状态 / 最近时间），下面是选中
 * 会话的轮次时间线（输入摘要、结果、耗时、用量、估值成本），以及三个操作 ——
 * 追问（带 `session_id` 派下一轮）、取消本轮、关闭会话。
 *
 * 三态必须都不崩，这是 verifier 能在隔离 profile 里先跑起来的前提：
 * 没有会话（空态）、宿主拒绝（403）、宿主没有这族路由（404 / 非 JSON）。
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  ExternalSessionApiError,
  failureCopyKey,
  type ExternalSessionApi,
  type ExternalSessionErrorCode,
} from './api.ts'
import {
  blockedReason,
  closable,
  continueAllowed,
  formatAge,
  formatCost,
  formatDuration,
  formatUsage,
  orderedTurns,
  pickSession,
  summarize,
  turnInFlight,
} from './view.ts'
import type { ExternalSessionStore } from './store.ts'
import type { ExternalSessionView, ExternalTurnViewStatus } from './types.ts'
import type { ExternalSessionLocaleKey } from './i18n.ts'
import { EXTERNAL_SESSION_PLUGIN, PANEL_PART } from './constants.ts'
import { PageNotice } from '../sidebar/page-shell.tsx'
import css from './external-session.module.css'

/** 有会话在跑时的列表轮询间隔。 */
const RUNNING_POLL_MS = 1_500

/** 面板的翻译函数（位置模块绑定 locale 后注入，测试直接给 zh）。 */
export type ExternalSessionTranslate = (
  key: ExternalSessionLocaleKey,
  params?: Record<string, string | number>,
) => string

/** 面板属性。 */
export interface ExternalSessionPanelProps {
  /** 列出会话、派轮次、取消、关闭 —— 面板唯一的写入口。 */
  api: ExternalSessionApi
  /** 列表快照源（与下拉分组共用一份）。 */
  store: ExternalSessionStore
  /** 本地化。 */
  t: ExternalSessionTranslate
  /** 下拉条目点名要打开哪个会话（导航参数）。 */
  initialSessionId?: string
  /**
   * 当前会话的 id。给了就只显示本会话派出去的外援；未标注来源的历史记录
   * 只在「全部会话」里出现。
   */
  conversationId?: string
  /** 页签可见性：不可见时不取数。 */
  visible?: boolean
  /** 页签级中止信号（官方框架在切换页签时给出）。 */
  signal?: AbortSignal
}

/**
 * 宿主错误码 → 面板句子。契约里 `code` 是权威，所以先按码说具体原因，
 * 认不出码才退回「权限 / 宿主未提供 / 其它失败」这三档。
 */
const CODE_COPY: Readonly<Record<ExternalSessionErrorCode, ExternalSessionLocaleKey>> = {
  'cwd-invalid': 'fail.cwd-invalid',
  'session-unknown': 'fail.session-unknown',
  'session-closed': 'fail.session-closed',
  'session-unresumable': 'fail.session-unresumable',
  busy: 'fail.busy',
  limit: 'fail.limit',
  'auth-required': 'fail.auth-required',
  'provider-missing': 'fail.provider-missing',
  'provider-error': 'fail.provider-error',
}

/** 一句话把失败说清楚：先按错误码，再按失败种类。 */
function describeFailure(error: Error, t: ExternalSessionTranslate): string {
  if (error instanceof ExternalSessionApiError) {
    if (error.code !== undefined) return t(CODE_COPY[error.code])
    return t(failureCopyKey(error.failure), { message: error.message })
  }
  return t('state.failed', { message: error.message })
}

function statusLabel(status: ExternalSessionView['status'], t: ExternalSessionTranslate): string {
  return t(`status.${status}` as ExternalSessionLocaleKey)
}

function turnStatusLabel(status: ExternalTurnViewStatus, t: ExternalSessionTranslate): string {
  return t(`turn.status.${status}` as ExternalSessionLocaleKey)
}

/** 会话的展示名：标题为空时退回 id，避免出现一行空白。 */
function displayTitle(session: ExternalSessionView): string {
  return session.title === '' ? session.id : session.title
}

function lastActivityText(session: ExternalSessionView, t: ExternalSessionTranslate): string {
  const stamp = session.lastTurnAt ?? session.createdAt
  if (stamp === undefined) return t('session.noTime')
  const age = formatAge(stamp, Date.now())
  return age === '' ? t('session.noTime') : age
}

/** 轮次时间线：每轮一张卡片，字段一律可缺省。 */
function TurnTimeline({ session, t }: { session: ExternalSessionView; t: ExternalSessionTranslate }) {
  const turns = orderedTurns(session)
  if (turns.length === 0) {
    return <p className={css.notice} data-dsh-part="timeline-empty">{t('timeline.empty')}</p>
  }
  return (
    <ol className={css.timeline} data-dsh-part="timeline">
      {turns.map(turn => {
        const duration = formatDuration(turn.durationMs)
        const usage = formatUsage(turn.usage)
        const cost = formatCost(turn.costUsd)
        return (
          <li key={turn.n} className={css.turn} data-dsh-part="turn" data-turn-status={turn.status}>
            <div className={css.turnHead}>
              <span className={css.turnNumber}>{t('timeline.number', { n: turn.n })}</span>
              <span className={css.turnStatus} data-dsh-part="turn-status">{turnStatusLabel(turn.status, t)}</span>
              {duration === undefined ? null : <span className={css.turnMeta} data-dsh-part="turn-duration">{t('timeline.duration', { duration })}</span>}
              {usage === undefined ? null : <span className={css.turnMeta} data-dsh-part="turn-usage">{t('timeline.usage', usage)}</span>}
              {cost === undefined ? null : <span className={css.turnMeta} data-dsh-part="turn-cost">{t('timeline.cost', { cost })}</span>}
            </div>
            <div className={css.turnBody}>
              <span className={css.turnField}>{t('timeline.prompt')}</span>
              <p className={css.turnPrompt} data-dsh-part="turn-prompt">{summarize(turn.prompt, 160)}</p>
            </div>
            <div className={css.turnBody}>
              <span className={css.turnField}>{t('timeline.result')}</span>
              {turn.result === undefined
                ? <p className={css.turnResultEmpty} data-dsh-part="turn-result">{t('timeline.noResult')}</p>
                : <p className={css.turnResult} data-dsh-part="turn-result">{summarize(turn.result, 900)}</p>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** 右侧面板主体。 */
export function ExternalSessionPanel({
  api,
  store,
  t,
  initialSessionId,
  conversationId,
  visible = true,
  signal,
}: ExternalSessionPanelProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [showAll, setShowAll] = useState(false)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)

  // 会话绑定：默认只看本会话派出去的外援。没有来源标注的历史记录不参与默认
  // 列表——它们无法归属任何会话，只能进「全部会话」这个显式请求。
  const scoped = useMemo(() => {
    if (showAll || conversationId === undefined) return snapshot.sessions
    return snapshot.sessions.filter(session => session.originSessionId === conversationId)
  }, [snapshot.sessions, conversationId, showAll])
  const [pending, setPending] = useState<'continue' | 'cancel' | 'close' | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')

  const selected = useMemo(
    () => pickSession(scoped, selectedId ?? initialSessionId),
    [scoped, selectedId, initialSessionId],
  )
  const running = scoped.some(session => session.status === 'running')

  // 下拉条目点名要看某个会话时，导航参数一变就切过去（用户仍可随后手动改选）。
  useEffect(() => {
    if (initialSessionId !== undefined) setSelectedId(initialSessionId)
  }, [initialSessionId])

  // 取数节奏：打开页签先读一次；只有存在运行中的会话才轮询（宿主 continue
  // 是「立刻返回 + 异步起跑」，所以运行态只能靠轮询收敛），跑完就停。
  useEffect(() => {
    if (!visible) return
    void store.refresh()
    if (!running) return
    const interval = window.setInterval(() => { void store.refresh() }, RUNNING_POLL_MS)
    return () => { window.clearInterval(interval) }
  }, [store, visible, running])

  /** 跑一个操作；成功返回 true，失败把原因放在面板里并返回 false。 */
  const runAction = useCallback(async (
    kind: 'continue' | 'cancel' | 'close',
    operation: () => Promise<readonly ExternalSessionView[]>,
  ): Promise<boolean> => {
    setPending(kind)
    setActionError(undefined)
    try {
      await store.apply(operation)
      return true
    } catch (cause) {
      if ((cause as { name?: unknown } | null)?.name === 'AbortError') return false
      setActionError(cause instanceof Error ? describeFailure(cause, t) : String(cause))
      return false
    } finally {
      setPending(undefined)
    }
  }, [store, t])

  const submitContinuation = (event: { preventDefault: () => void }): void => {
    event.preventDefault()
    if (selected === undefined || pending !== undefined) return
    const prompt = draft.trim()
    if (prompt === '' || !continueAllowed(selected)) return
    // 只有被宿主接纳才清空输入；拒绝时保留用户已写的内容。
    void runAction('continue', () => api.continueTurn(selected.id, prompt, signal)).then(accepted => { if (accepted) setDraft('') })
  }

  const error = snapshot.error
  const showLoading = snapshot.state === 'loading' && snapshot.sessions.length === 0
  const showFailure = error !== undefined && snapshot.sessions.length === 0
  const showEmpty = snapshot.state !== 'loading' && scoped.length === 0 && error === undefined
  const blocked = blockedReason(selected)

  return (
    <div className={css.root} data-dsh-plugin={EXTERNAL_SESSION_PLUGIN} data-dsh-part={PANEL_PART}>
      <header className={css.head} data-dsh-part="panel-head">
        <div className={css.headText}>
          <h2 className={css.title} data-dsh-part="panel-title">{t('panel.title')}</h2>
          <p className={css.intro} data-dsh-part="panel-count">{t('panel.count', { count: scoped.length })}</p>
        </div>
        <label className={css.scope} data-dsh-part="scope-toggle">
          <input
            type="checkbox"
            checked={showAll || conversationId === undefined}
            disabled={conversationId === undefined}
            onChange={event => { setShowAll(event.target.checked) }}
          />
          {t('scoped.all')}
        </label>
        <button
          type="button"
          className={css.secondary}
          data-dsh-part="refresh"
          disabled={snapshot.state === 'loading'}
          onClick={() => { void store.refresh() }}
        >
          {t('panel.refresh')}
        </button>
      </header>

      {showLoading ? <PageNotice kind="loading">{t('panel.loading')}</PageNotice> : null}
      {showFailure ? (
        <PageNotice
          kind="error"
          action={<button type="button" className={css.secondary} onClick={() => { void store.refresh() }}>{t('action.retry')}</button>}
        >
          {describeFailure(error, t)}
        </PageNotice>
      ) : null}
      {showEmpty ? <PageNotice kind="empty">{t('list.empty')}</PageNotice> : null}

      {scoped.length === 0 ? null : (
        <ul className={css.list} data-dsh-part="list" aria-label={t('list.title')}>
          {scoped.map(session => (
            <li key={session.id}>
              <button
                type="button"
                className={css.row}
                data-dsh-part="session"
                data-session-id={session.id}
                data-session-status={session.status}
                aria-current={session.id === selected?.id ? 'true' : undefined}
                aria-label={t('session.meta', {
                  provider: session.provider,
                  status: statusLabel(session.status, t),
                  time: lastActivityText(session, t),
                })}
                onClick={() => { setSelectedId(session.id); setActionError(undefined) }}
              >
                <span className={css.rowTitle} data-dsh-part="session-title">{displayTitle(session)}</span>
                <span className={css.rowMeta}>
                  <span className={css.pill} data-state={session.status}>{statusLabel(session.status, t)}</span>
                  <span className={css.rowProvider} data-dsh-part="session-provider">{session.provider}</span>
                  <span className={css.rowTime} data-dsh-part="session-time">{lastActivityText(session, t)}</span>
                  {conversationId === undefined || session.originSessionId === conversationId ? null : (
                    <span className={css.rowScope} data-dsh-part="session-scope">
                      {session.originSessionId === undefined ? t('scoped.unknown') : t('scoped.other')}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected === undefined ? null : (
        <section className={css.detail} data-dsh-part="detail" data-session-id={selected.id}>
          <header className={css.detailHead}>
            <h3 className={css.detailTitle} data-dsh-part="detail-title">{displayTitle(selected)}</h3>
            <span className={css.pill} data-state={selected.status}>{statusLabel(selected.status, t)}</span>
          </header>
          <div className={css.actions} data-dsh-part="actions">
            {turnInFlight(selected) ? (
              <button
                type="button"
                className={css.danger}
                data-dsh-part="cancel"
                disabled={pending !== undefined}
                onClick={() => { void runAction('cancel', () => api.cancelTurn(selected.id, signal)) }}
              >
                {pending === 'cancel' ? t('action.cancelling') : t('action.cancel')}
              </button>
            ) : null}
            {closable(selected) ? (
              <button
                type="button"
                className={css.secondary}
                data-dsh-part="close"
                disabled={pending !== undefined}
                onClick={() => { void runAction('close', () => api.closeSession(selected.id, signal)) }}
              >
                {pending === 'close' ? t('action.closing') : t('action.close')}
              </button>
            ) : null}
          </div>
          <TurnTimeline session={selected} t={t}/>
          <form className={css.compose} data-dsh-part="continue" onSubmit={submitContinuation}>
            <input
              className={css.input}
              data-dsh-part="continue-input"
              aria-label={t('action.continueLabel')}
              placeholder={t('action.continuePlaceholder')}
              value={draft}
              disabled={!continueAllowed(selected) || pending !== undefined}
              onChange={event => { setDraft(event.target.value) }}
            />
            <button
              type="submit"
              className={css.primary}
              data-dsh-part="continue-submit"
              disabled={!continueAllowed(selected) || pending !== undefined || draft.trim() === ''}
            >
              {pending === 'continue' ? t('action.sending') : t('action.continue')}
            </button>
          </form>
          {blocked === undefined ? null : (
            <p className={css.notice} data-dsh-part="blocked">{t(`blocked.${blocked}` as ExternalSessionLocaleKey)}</p>
          )}
          {actionError === undefined ? null : (
            <p className={css.actionError} data-dsh-part="action-error">{actionError}</p>
          )}
        </section>
      )}
    </div>
  )
}
/** 官方右栏页签给出的 tab 信息面（只读我们要的两项）。 */
export interface ExternalSessionTabInfo {
  readonly tab: {
    readonly visible: boolean
    readonly navigation: { readonly params: Record<string, unknown> }
  }
}

/** 页签属性：位置模块把数据面与本地化注入进来。 */
export interface ExternalSessionTabProps {
  readonly api: ExternalSessionApi
  readonly store: ExternalSessionStore
  readonly t: ExternalSessionTranslate
  readonly useTabInfo?: () => ExternalSessionTabInfo
  /** 页签所在会话：默认只显示这个会话派出去的外援。 */
  readonly conversationId?: string
}

/**
 * 右栏页签的薄封装：把导航参数里的 `sessionId`（下拉条目点名要看的会话）变成
 * 面板的初始选中，其余交给 {@link ExternalSessionPanel}。
 */
export function ExternalSessionTab({ api, store, t, useTabInfo, conversationId }: ExternalSessionTabProps) {
  const info = useTabInfo?.()
  const params = info?.tab.navigation.params ?? {}
  const requested = params.sessionId
  const initialSessionId = typeof requested === 'string' && requested !== '' ? requested : undefined
  return (
    <ExternalSessionPanel
      api={api}
      store={store}
      t={t}
      {...(initialSessionId === undefined ? {} : { initialSessionId })}
      {...(conversationId === undefined ? {} : { conversationId })}
      visible={info?.tab.visible ?? true}
    />
  )
}
