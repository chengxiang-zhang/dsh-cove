/** Attended, single-owner lease for the user's attached Chrome browser. */
import type { ResolvedPlaywrightSessionsConfig } from '../../../core/playwright-sessions/contracts.ts'
import { PlaywrightControlError, type PlaywrightConnectionStatus } from '../../../core/playwright-sessions/control.ts'
import type { SessionBrowserManager } from './manager.ts'

interface ControllerOptions {
  config: ResolvedPlaywrightSessionsConfig
  manager: SessionBrowserManager
  sessionExists(sessionId: string): boolean | Promise<boolean>
}

export class PlaywrightSessionsController {
  private ownerId: string | undefined
  private state: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected'
  private error: { code: string; message: string } | undefined
  private connectPromise: Promise<PlaywrightConnectionStatus> | undefined

  constructor(private readonly options: ControllerOptions) {}

  status(sessionId: string): PlaywrightConnectionStatus {
    if (this.options.config.mode !== 'extension') {
      return {
        mode: this.options.config.mode,
        state: 'unavailable',
        ownedByThisSession: false,
        busy: false,
        liveView: this.options.config.liveView,
      }
    }
    const ownedByThisSession = this.ownerId === sessionId
    return {
      mode: 'extension',
      state: ownedByThisSession ? this.state : 'disconnected',
      ownedByThisSession,
      busy: this.ownerId !== undefined && !ownedByThisSession,
      liveView: false,
      ...(ownedByThisSession && this.error !== undefined ? { errorCode: this.error.code, errorMessage: this.error.message } : {}),
    }
  }

  async connect(sessionId: string): Promise<PlaywrightConnectionStatus> {
    if (this.options.config.mode !== 'extension') throw new PlaywrightControlError('wrong-mode', 'Chrome extension mode is not enabled')
    if (!await this.options.sessionExists(sessionId)) throw new PlaywrightControlError('not-found', 'session does not exist')
    if (this.ownerId !== undefined && this.ownerId !== sessionId) throw new PlaywrightControlError('busy', 'Chrome is already connected to another session')
    if (this.ownerId === sessionId && this.state === 'connected') return this.status(sessionId)
    if (this.ownerId === sessionId && this.connectPromise !== undefined) return this.connectPromise

    this.ownerId = sessionId
    this.state = 'connecting'
    this.error = undefined
    const run = (async () => {
      try {
        const browser = await this.options.manager.get(sessionId)
        // Browser creation is lazy inside Playwright MCP. This harmless call
        // deliberately opens the official extension approval/tab picker.
        await browser.call('browser_tabs', { action: 'list' })
        this.state = 'connected'
        return this.status(sessionId)
      } catch (cause) {
        await this.options.manager.dispose(sessionId)
        if (this.ownerId === sessionId) {
          this.ownerId = undefined
          this.state = 'disconnected'
          this.error = undefined
        }
        const message = cause instanceof Error ? cause.message : String(cause)
        throw new PlaywrightControlError('connect-failed', message)
      }
    })()
    this.connectPromise = run
    try { return await run } finally { if (this.connectPromise === run) this.connectPromise = undefined }
  }

  async disconnect(sessionId: string): Promise<PlaywrightConnectionStatus> {
    if (this.options.config.mode !== 'extension') throw new PlaywrightControlError('wrong-mode', 'Chrome extension mode is not enabled')
    if (this.ownerId !== undefined && this.ownerId !== sessionId) throw new PlaywrightControlError('not-owner', 'this session does not own the Chrome connection')
    await this.options.manager.dispose(sessionId)
    this.release(sessionId)
    return this.status(sessionId)
  }

  requireOwner(sessionId: string): void {
    if (this.options.config.mode !== 'extension') return
    if (sessionId === '' || this.ownerId !== sessionId || this.state !== 'connected') {
      throw new PlaywrightControlError('not-owner', 'Connect this session from the Agent Browser panel before using local Chrome')
    }
  }

  release(sessionId: string): void {
    if (this.ownerId !== sessionId) return
    this.ownerId = undefined
    this.state = 'disconnected'
    this.error = undefined
    this.connectPromise = undefined
  }

  async dispose(): Promise<void> {
    const owner = this.ownerId
    if (owner !== undefined) await this.options.manager.dispose(owner)
    this.release(owner ?? '')
  }
}
