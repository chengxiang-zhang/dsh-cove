/** Wire-protocol unit tests for the agent-browser live view. */
import { describe, expect, it } from 'vitest'
import {
  buildFrameMessage, buildStatusMessage, mapInputMessage, type ScreencastFrame,
} from '../src/core/playwright-sessions/wire.ts'

const frame: ScreencastFrame = {
  data: 'aGVsbG8=',
  metadata: { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1 },
  sessionId: 7,
}

describe('agent-browser live view wire protocol', () => {
  it('serializes a screencast frame with device metrics', () => {
    const parsed = JSON.parse(buildFrameMessage(frame)) as Record<string, unknown>
    expect(parsed.type).toBe('frame')
    expect(parsed.data).toBe('aGVsbG8=')
    expect(parsed.deviceWidth).toBe(1280)
    expect(parsed.deviceHeight).toBe(800)
    expect(parsed.pageScaleFactor).toBe(1)
  })

  it('serializes lifecycle status messages (with and without a message)', () => {
    expect(JSON.parse(buildStatusMessage('no-page'))).toEqual({ type: 'status', state: 'no-page' })
    expect(JSON.parse(buildStatusMessage('error', 'boom'))).toEqual({ type: 'status', state: 'error', message: 'boom' })
  })

  it('maps a mouse move / press / wheel into Input.dispatchMouseEvent', () => {
    const move = mapInputMessage({ type: 'input', input: 'mouse', action: 'move', x: 10, y: 20 })!
    expect(move.method).toBe('Input.dispatchMouseEvent')
    expect(move.params).toMatchObject({ type: 'mouseMoved', x: 10, y: 20 })

    const press = mapInputMessage({ type: 'input', input: 'mouse', action: 'down', x: 1, y: 2, button: 'left', buttons: 1, clickCount: 1 })!
    expect(press.params).toMatchObject({ type: 'mousePressed', button: 'left', clickCount: 1 })

    const wheel = mapInputMessage({ type: 'input', input: 'mouse', action: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: 100 })!
    expect(wheel.method).toBe('Input.dispatchMouseEvent')
    expect(wheel.params.deltaY).toBe(100)
  })

  it('maps keyboard type / down / up', () => {
    const type = mapInputMessage({ type: 'input', input: 'keyboard', action: 'type', text: 'hi' })!
    expect(type.method).toBe('Input.insertText')
    expect(type.params).toEqual({ text: 'hi' })

    const down = mapInputMessage({ type: 'input', input: 'keyboard', action: 'down', key: 'Enter', code: 'Enter' })!
    expect(down.method).toBe('Input.dispatchKeyEvent')
    expect(down.params).toMatchObject({ type: 'keyDown', key: 'Enter' })
  })

  it('drops malformed or non-whitelisted messages', () => {
    expect(mapInputMessage(null)).toBeNull()
    expect(mapInputMessage({ type: 'input', input: 'mouse', action: 'move', x: Number.NaN, y: 1 })).toBeNull()
    expect(mapInputMessage({ type: 'input', input: 'unknown', action: 'x', x: 1, y: 1 })).toBeNull()
    expect(mapInputMessage({ type: 'raw', method: 'Page.crash' })).toBeNull()
    expect(mapInputMessage('string')).toBeNull()
  })
})