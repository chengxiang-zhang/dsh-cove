import { useCallback, useEffect, useState } from 'react'
import type { PlaywrightConnectionStatus } from '../../core/playwright-sessions/control.ts'
import { PLAYWRIGHT_CONTROL_API_PREFIX } from '../../core/playwright-sessions/control.ts'
import css from './sidebar.module.css'

const EXTENSION_URL = 'https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm'

type T = (key: import('./right-pane-i18n.ts').RightPaneLocaleKey) => string
interface Envelope<TValue> { ok: boolean; value?: TValue; error?: { code?: string; message?: string } }

/** One control-plane failure carrying the HTTP status, so a refused request
 *  (the host access fence answering 403) reads differently from a connection
 *  error inside an accepted request. */
class ControlError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ControlError' }
}

async function control(path: string, sessionId: string, signal?: AbortSignal): Promise<PlaywrightConnectionStatus> {
  const response = path === 'status'
    ? await fetch(`${PLAYWRIGHT_CONTROL_API_PREFIX}/status?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store', credentials: 'same-origin', signal })
    : await fetch(`${PLAYWRIGHT_CONTROL_API_PREFIX}/${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
        signal,
      })
  const envelope = await response.json().catch(() => null) as Envelope<PlaywrightConnectionStatus> | null
  if (!response.ok || envelope === null || !envelope.ok || envelope.value === undefined) {
    throw new ControlError(envelope?.error?.message ?? `${response.status} ${response.statusText}`, response.status)
  }
  return envelope.value
}

export function AgentBrowserPanel({ sessionId, visible = true, signal, t }: { sessionId?: string; visible?: boolean; signal?: AbortSignal; t: T }) {
  const [status, setStatus] = useState<PlaywrightConnectionStatus>()
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [errorStatus, setErrorStatus] = useState<number>()

  const refresh = useCallback(async (controller?: AbortController) => {
    if (!sessionId) { setStatus(undefined); return }
    try {
      const next = await control('status', sessionId, controller?.signal ?? signal)
      setStatus(next)
      setError('')
      setErrorStatus(undefined)
    } catch (cause) {
      if ((cause as { name?: unknown })?.name === 'AbortError') return
      setError(cause instanceof Error ? cause.message : String(cause))
      setErrorStatus(cause instanceof ControlError ? cause.status : undefined)
    }
  }, [sessionId, signal])

  useEffect(() => {
    if (!visible || !sessionId) return
    const abort = new AbortController()
    void refresh(abort)
    const timer = setInterval(() => { void refresh(abort) }, status?.state === 'connecting' ? 1_000 : 5_000)
    const stop = () => abort.abort()
    signal?.addEventListener('abort', stop, { once: true })
    return () => { clearInterval(timer); abort.abort(); signal?.removeEventListener('abort', stop) }
  }, [refresh, sessionId, signal, status?.state, visible])

  const act = async (path: 'connect' | 'disconnect') => {
    if (!sessionId || working) return
    setWorking(true); setError(''); setErrorStatus(undefined)
    if (path === 'connect') setStatus(current => current ? { ...current, state: 'connecting' } : current)
    try { setStatus(await control(path, sessionId, signal)) }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setErrorStatus(cause instanceof ControlError ? cause.status : undefined)
      await refresh()
    }
    finally { setWorking(false) }
  }

  const unavailable = status?.mode !== 'extension'
  const connected = status?.ownedByThisSession && status.state === 'connected'
  /** A refused control-plane call (403 from the host access fence) is an
   *  admission problem, not the isolated-browser default. */
  const denied = errorStatus === 403
  const message = !sessionId ? t('agentBrowser.noSession')
    : error !== '' ? (denied ? t('agentBrowser.denied') : t('agentBrowser.error'))
      : status?.busy ? t('agentBrowser.busy')
        : unavailable ? t('agentBrowser.notEnabled')
          : status?.state === 'connecting' ? t('agentBrowser.connecting')
            : connected ? t('agentBrowser.live')
              : t('agentBrowser.closed')
  const failure = error === '' ? status?.errorMessage : denied ? t('agentBrowser.denied') : error

  return <div className={css.agentBrowser} data-dsh-plugin="better-sidebar" data-dsh-part="agent-browser">
    <header className={css.agentBrowserHeader}>
      <div>
        <strong>{t('agentBrowser.title')}</strong>
        <p>{t('agentBrowser.description')}</p>
      </div>
      <span className={css.agentBrowserState} data-state={error !== '' ? 'error' : connected ? 'connected' : status?.state ?? 'disconnected'}>{message}</span>
    </header>
    <div className={css.agentBrowserBody}>
      <div className={css.agentBrowserGraphic} aria-hidden="true"><span/><span/><span/></div>
      <p>{t('agentBrowser.hint')}</p>
      {!connected && !unavailable && <p>{t('agentBrowser.installHint')} <a href={EXTENSION_URL} target="_blank" rel="noreferrer">{t('agentBrowser.install')}</a></p>}
      <p className={css.agentBrowserSecurity}>{t('agentBrowser.security')}</p>
      {failure !== undefined && failure !== '' && <div className={css.agentBrowserError} role="alert">{failure}</div>}
    </div>
    <footer className={css.agentBrowserActions}>
      <button type="button" onClick={() => void refresh()} disabled={!sessionId || working}>{t('agentBrowser.refresh')}</button>
      {connected
        ? <button type="button" className={css.agentBrowserPrimary} onClick={() => void act('disconnect')} disabled={working}>{t('agentBrowser.disconnect')}</button>
        : <button type="button" className={css.agentBrowserPrimary} onClick={() => void act('connect')} disabled={!sessionId || unavailable || status?.busy || working}>{t('agentBrowser.connect')}</button>}
    </footer>
  </div>
}
