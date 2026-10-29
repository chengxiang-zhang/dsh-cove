/** Public, secret-free control-plane contracts for the Agent Browser panel. */
import type { PlaywrightConnectionMode } from './contracts.ts'

export const PLAYWRIGHT_CONTROL_API_PREFIX = '/api/playwright-sessions'

export type PlaywrightConnectionState = 'unavailable' | 'disconnected' | 'connecting' | 'connected' | 'error'

export interface PlaywrightConnectionStatus {
  mode: PlaywrightConnectionMode
  state: PlaywrightConnectionState
  ownedByThisSession: boolean
  busy: boolean
  liveView: boolean
  errorCode?: string
  errorMessage?: string
}

export type PlaywrightControlErrorCode =
  | 'bad-request'
  | 'forbidden'
  | 'not-found'
  | 'busy'
  | 'wrong-mode'
  | 'not-owner'
  | 'connect-failed'
  | 'internal'

export class PlaywrightControlError extends Error {
  constructor(readonly code: PlaywrightControlErrorCode, message: string) {
    super(message)
    this.name = 'PlaywrightControlError'
  }
}
