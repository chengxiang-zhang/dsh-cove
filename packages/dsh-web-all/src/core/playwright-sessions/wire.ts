/** Pure wire-protocol helpers for the agent-browser live-view WebSocket.
 *
 * One text protocol, two directions:
 *
 *   server -> client
 *     { type: 'frame', data, deviceWidth, deviceHeight, pageScaleFactor }  CDP screencast JPEG
 *     { type: 'status', state: 'no-page' | 'browser-closed' | 'error', message? }  lifecycle
 *
 *   client -> server (strict input whitelist, never arbitrary CDP methods)
 *     { type: 'input', input: 'mouse', action: 'move'|'down'|'up'|'wheel', x, y, button?, buttons?, clickCount?, deltaX?, deltaY? }
 *     { type: 'input', input: 'keyboard', action: 'down'|'up'|'type', key?, code?, text? }
 *
 * `x`/`y` are CSS-viewport coordinates already scaled by the client against
 * the frame's device dimensions. These helpers are pure (no I/O) so the
 * message building and input -> CDP mapping are unit-testable in isolation.
 */

/** One `Page.screencastFrame` CDP payload (structural subset we read). */
export interface ScreencastFrame {
  data: string
  metadata: {
    deviceWidth: number
    deviceHeight: number
    pageScaleFactor: number
    [key: string]: unknown
  }
  sessionId: number
}

/** Serialize one screencast JPEG frame for the wire. */
export function buildFrameMessage(frame: ScreencastFrame): string {
  return JSON.stringify({
    type: 'frame',
    data: frame.data,
    deviceWidth: frame.metadata.deviceWidth,
    deviceHeight: frame.metadata.deviceHeight,
    pageScaleFactor: frame.metadata.pageScaleFactor,
  })
}

/** Serialize a lifecycle status message for the wire. */
export function buildStatusMessage(state: 'no-page' | 'browser-closed' | 'error', message?: string): string {
  if (message !== undefined) return JSON.stringify({ type: 'status', state, message })
  return JSON.stringify({ type: 'status', state })
}

/** A concrete CDP command ready to dispatch to the attached page session. */
export interface CdpCommand {
  method: string
  params: Record<string, unknown>
}

/** Normalized mouse input accepted from the client. */
export interface MouseInputMessage {
  type: 'input'
  input: 'mouse'
  action: 'move' | 'down' | 'up' | 'wheel'
  x: number
  y: number
  button?: string
  buttons?: number
  clickCount?: number
  deltaX?: number
  deltaY?: number
}

/** Normalized keyboard input accepted from the client. */
export interface KeyboardInputMessage {
  type: 'input'
  input: 'keyboard'
  action: 'down' | 'up' | 'type'
  key?: string
  code?: string
  text?: string
}

const MOUSE_ACTIONS = new Set(['move', 'down', 'up', 'wheel'])

/**
 * Map a whitelisted mouse input into `Input.dispatchMouseEvent`. Returns
 * null when the message is malformed (missing/non-finite x/y or an unknown
 * action) so the caller silently ignores it rather than forwarding junk.
 */
export function mapMouseInput(msg: MouseInputMessage): CdpCommand | null {
  if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return null
  if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return null
  if (!MOUSE_ACTIONS.has(msg.action)) return null
  const type =
    msg.action === 'wheel' ? 'mouseWheel'
    : msg.action === 'down' ? 'mousePressed'
    : msg.action === 'up' ? 'mouseReleased'
    : 'mouseMoved'
  const params: Record<string, unknown> = {
    type,
    x: msg.x,
    y: msg.y,
    button: typeof msg.button === 'string' ? msg.button : 'none',
    buttons: typeof msg.buttons === 'number' ? msg.buttons : 0,
    clickCount: typeof msg.clickCount === 'number' ? msg.clickCount : 1,
  }
  if (typeof msg.deltaX === 'number') params.deltaX = msg.deltaX
  if (typeof msg.deltaY === 'number') params.deltaY = msg.deltaY
  return { method: 'Input.dispatchMouseEvent', params }
}

/**
 * Map a whitelisted keyboard input into `Input.insertText` (action 'type')
 * or `Input.dispatchKeyEvent` (action 'down'/'up'). Returns null for an
 * unknown action or a 'type' without text.
 */
export function mapKeyboardInput(msg: KeyboardInputMessage): CdpCommand | null {
  if (msg.action === 'type') {
    if (typeof msg.text !== 'string') return null
    return { method: 'Input.insertText', params: { text: msg.text } }
  }
  if (msg.action === 'down' || msg.action === 'up') {
    const params: Record<string, unknown> = {
      type: msg.action === 'down' ? 'keyDown' : 'keyUp',
      key: typeof msg.key === 'string' ? msg.key : '',
      code: typeof msg.code === 'string' ? msg.code : '',
    }
    if (typeof msg.text === 'string') params.text = msg.text
    return { method: 'Input.dispatchKeyEvent', params }
  }
  return null
}

/**
 * The single input entry point. Only `type: 'input'` messages with a
 * recognized `input` kind ever produce a command; every other shape
 * (including any attempted raw CDP method name) is dropped here.
 */
export function mapInputMessage(raw: unknown): CdpCommand | null {
  if (typeof raw !== 'object' || raw === null) return null
  const msg = raw as { type?: unknown; input?: unknown }
  if (msg.type !== 'input') return null
  if (msg.input === 'mouse') return mapMouseInput(msg as unknown as MouseInputMessage)
  if (msg.input === 'keyboard') return mapKeyboardInput(msg as unknown as KeyboardInputMessage)
  return null
}