import { useEffect, useState, type ReactNode } from 'react'
import type { Translate } from './i18n.ts'
import styles from './lark-wizard.module.css'

export type WizardPhase = 'idle' | 'awaiting-browser' | 'awaiting-secret' | 'done' | 'failed'

export interface WizardStatus {
  phase: WizardPhase
  mode?: 'new' | 'bind'
  consoleUrl?: string
  needsSecretPaste?: boolean
  appId?: string
  error?: string
}

interface StartNewResult { verificationUrl: string; qr: string | null }
interface StartBindResult { consoleUrl: string }

type WizardView =
  | { kind: 'idle' }
  | { kind: 'creating'; verificationUrl?: string; qr: string | null }
  | { kind: 'bind-form' }
  | { kind: 'bind-awaiting'; consoleUrl?: string }
  | { kind: 'connected'; appId?: string; needsSecretPaste: boolean }
  | { kind: 'failed'; error?: string }

const WIZARD_BASE = '/lark-inbox/wizard'
export const WIZARD_POLL_INTERVAL_MS = 2000

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `lark-inbox wizard request failed (${response.status})`)
  return body
}

function request<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(`${WIZARD_BASE}${path}`, init).then(readJson<T>)
}

function post<T>(path: string, payload?: unknown): Promise<T> {
  return request(path, {
    method: 'POST',
    ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
  })
}

function get<T>(path: string): Promise<T> {
  return request(path, { cache: 'no-store' })
}

function summarize(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface LarkInboxWizardProps {
  t: Translate
  disabled?: boolean
}

export function LarkInboxWizard({ t, disabled = false }: LarkInboxWizardProps): ReactNode {
  const [view, setView] = useState<WizardView>({ kind: 'idle' })
  const [busy, setBusy] = useState(false)
  const [bindAppId, setBindAppId] = useState('')
  const [bindAppSecret, setBindAppSecret] = useState('')

  useEffect(() => {
    let live = true
    void get<WizardStatus>('/status').then((next) => {
      if (!live) return
      if (next.phase === 'done') setView({ kind: 'connected', appId: next.appId, needsSecretPaste: next.needsSecretPaste === true })
      else if (next.phase === 'awaiting-browser') setView({ kind: 'creating', qr: null })
      else if (next.phase === 'awaiting-secret') setView({ kind: 'connected', appId: next.appId, needsSecretPaste: true })
      else if (next.phase === 'failed') setView({ kind: 'failed', error: next.error })
    }).catch(() => undefined)
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (view.kind !== 'creating') return
    let live = true
    const tick = async (): Promise<void> => {
      try {
        const next = await get<WizardStatus>('/status')
        if (!live || next.phase === 'awaiting-browser') return
        if (next.phase === 'done') setView({ kind: 'connected', appId: next.appId, needsSecretPaste: next.needsSecretPaste === true })
        else if (next.phase === 'awaiting-secret') setView({ kind: 'connected', appId: next.appId, needsSecretPaste: true })
        else if (next.phase === 'failed') setView({ kind: 'failed', error: next.error })
        else setView({ kind: 'idle' })
      } catch (error) {
        if (live) setView({ kind: 'failed', error: summarize(error) })
      }
    }
    void tick()
    const interval = globalThis.setInterval(() => { void tick() }, WIZARD_POLL_INTERVAL_MS)
    return () => { live = false; globalThis.clearInterval(interval) }
  }, [view.kind])

  const createNew = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await post<StartNewResult>('/start-new')
      setView({ kind: 'creating', verificationUrl: result.verificationUrl, qr: result.qr })
    } catch (error) {
      setView({ kind: 'failed', error: summarize(error) })
    } finally {
      setBusy(false)
    }
  }

  const confirmBind = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await post<StartBindResult>('/start-bind', { appId: bindAppId.trim() })
      setView({ kind: 'bind-awaiting', consoleUrl: result.consoleUrl })
    } catch (error) {
      setView({ kind: 'failed', error: summarize(error) })
    } finally {
      setBusy(false)
    }
  }

  const finishBind = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await post<{ ok: boolean }>('/finish-bind', { appSecret: bindAppSecret })
      setView({ kind: 'connected', appId: bindAppId.trim(), needsSecretPaste: false })
    } catch (error) {
      setView({ kind: 'failed', error: summarize(error) })
    } finally {
      setBusy(false)
    }
  }

  const clear = (): void => {
    setView({ kind: 'idle' })
    setBindAppId('')
    setBindAppSecret('')
  }

  const cancel = async (): Promise<void> => {
    try { await post<{ ok: boolean }>('/cancel') } catch { /* best effort */ }
    clear()
  }

  const cancelButton = <button type="button" className={styles.secondary} disabled={busy} onClick={() => { void cancel() }}>{t('wizard.cancel')}</button>
  let body: ReactNode

  if (view.kind === 'idle') {
    body = <div className={styles.actions} data-dsh-part="actions">
      <button type="button" className={styles.primary} disabled={disabled || busy} onClick={() => { void createNew() }}>{t('wizard.createNew')}</button>
      <button type="button" className={styles.secondary} disabled={disabled || busy} onClick={() => { setBindAppId(''); setBindAppSecret(''); setView({ kind: 'bind-form' }) }}>{t('wizard.bindExisting')}</button>
    </div>
  } else if (view.kind === 'creating') {
    body = <div className={styles.panel} data-dsh-part="authorization">
      {view.verificationUrl ? <p className={styles.hint}>{t('wizard.openLinkHint')}<a href={view.verificationUrl} target="_blank" rel="noreferrer" className={styles.link}>{view.verificationUrl}</a></p> : null}
      {view.qr !== null ? <img src={`${WIZARD_BASE}/qr.png`} alt={t('wizard.qrAlt')} className={styles.qr}/> : null}
      <p className={styles.hint}>{t('wizard.awaitingHint')}</p>
      <div className={styles.actions}>{cancelButton}</div>
    </div>
  } else if (view.kind === 'bind-form') {
    body = <div className={styles.panel} data-dsh-part="bind-form">
      <WizardField id="lark-inbox-wizard-bind-appid" label={t('wizard.appId')} hint={t('wizard.appIdHint')} value={bindAppId} disabled={disabled} onChange={setBindAppId}/>
      <WizardField id="lark-inbox-wizard-bind-appsecret" label={t('wizard.appSecret')} hint={t('wizard.appSecretHint')} value={bindAppSecret} disabled={disabled} secret onChange={setBindAppSecret}/>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={disabled || busy || bindAppId.trim() === '' || bindAppSecret.trim() === ''} onClick={() => { void confirmBind() }}>{t('wizard.confirmBind')}</button>
        {cancelButton}
      </div>
    </div>
  } else if (view.kind === 'bind-awaiting') {
    body = <div className={styles.panel} data-dsh-part="bind-finish">
      <p className={styles.meta}>{t('wizard.appId')}: {bindAppId.trim()}</p>
      {view.consoleUrl ? <p className={styles.hint}>{t('wizard.openConsoleHint')}<a href={view.consoleUrl} target="_blank" rel="noreferrer" className={styles.link}>{view.consoleUrl}</a></p> : null}
      <WizardField id="lark-inbox-wizard-finish-appsecret" label={t('wizard.appSecret')} hint={t('wizard.appSecretHint')} value={bindAppSecret} disabled={disabled} secret onChange={setBindAppSecret}/>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={disabled || busy || bindAppSecret.trim() === ''} onClick={() => { void finishBind() }}>{t('wizard.finishBind')}</button>
        {cancelButton}
      </div>
    </div>
  } else if (view.kind === 'connected') {
    body = <div className={styles.panel} data-dsh-part="result">
      {view.needsSecretPaste ? <p className={styles.hint}>{t('wizard.needsSecretHint')}</p> : <><p className={styles.success}>{t('wizard.connected', { appId: view.appId ?? '' })}</p><p className={styles.hint}>{t('wizard.connectedHint')}</p></>}
      <div className={styles.actions}><button type="button" className={styles.secondary} onClick={clear}>{t('wizard.back')}</button></div>
    </div>
  } else {
    body = <div className={styles.panel} data-dsh-part="result">
      <p className={styles.error} role="alert">{t('wizard.failed')}</p>
      {view.error ? <p className={styles.errorDetail}>{view.error}</p> : null}
      <p className={styles.hint}>{t('wizard.installHint')}</p>
      <div className={styles.actions}><button type="button" className={styles.secondary} onClick={clear}>{t('wizard.back')}</button></div>
    </div>
  }

  // 标题由面板外壳（LarkPanel）提供，这里不再重复渲染。
  return <div className={styles.wizard} data-dsh-plugin="lark-inbox" data-dsh-part="wizard">
    {body}
    {busy ? <p className={styles.hint} role="status">{t('wizard.busy')}</p> : null}
  </div>
}

function WizardField(props: { id: string; label: string; hint: string; value: string; disabled: boolean; secret?: boolean; onChange(text: string): void }): ReactNode {
  return <div className={styles.wizardField}>
    <label className={styles.label} htmlFor={props.id}>{props.label}</label>
    <input id={props.id} className={styles.input} type={props.secret ? 'password' : 'text'} value={props.value} autoComplete="off" spellCheck={false} disabled={props.disabled} onChange={event => { props.onChange(event.target.value) }}/>
    <p className={styles.hint}>{props.hint}</p>
  </div>
}

export const LARK_WIZARD_ROUTE_BASE = WIZARD_BASE
