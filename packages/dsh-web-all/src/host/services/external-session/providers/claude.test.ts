/**
 * The live-progress consumer, pinned against a recorded stream.
 *
 * `--include-partial-messages` makes one answer arrive as a `text_delta` frame
 * per chunk; the frames below are trimmed from a real capture (claude 2.1.318,
 * a 120-word answer: 8 frames without the flag, 74 with it). What matters is
 * that progress moves while the answer is still being written - without it a
 * long turn is indistinguishable from a dead one.
 */
import { describe, expect, it } from 'vitest'
import { consumeClaudeLines, type ClaudeLiveProgress } from './claude.ts'

const fresh = (): ClaudeLiveProgress => ({ frames: 0, toolCalls: 0, text: '', remainder: '', sawDeltas: false })

/** One `stream_event` line carrying a text delta. */
const delta = (text: string): string => JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
})

/** The `assistant` frame that repeats the whole message once it is complete. */
const assistant = (text: string): string => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})

describe('claude live progress', () => {
  it('accumulates text deltas and reports frames while the turn runs', () => {
    const state = fresh()
    consumeClaudeLines(state, `${delta('A JSON Lines ')}\n${delta('file is one JSON ')}\n`)
    expect(state.frames).toBe(2)
    expect(state.text).toBe('A JSON Lines file is one JSON ')

    consumeClaudeLines(state, `${delta('value per line.')}\n`)
    expect(state.frames).toBe(3)
    expect(state.text).toBe('A JSON Lines file is one JSON value per line.')
    expect(state.sawDeltas).toBe(true)
  })

  it('does not double the text when the assistant frame repeats it', () => {
    const state = fresh()
    const answer = 'A JSON Lines file is one JSON value per line.'
    consumeClaudeLines(state, `${delta('A JSON Lines ')}\n${delta('file is one JSON value per line.')}\n`)
    consumeClaudeLines(state, `${assistant(answer)}\n`)
    expect(state.text).toBe(answer)
  })

  it('still reads an older stream that carries no deltas', () => {
    const state = fresh()
    const answer = 'older CLI, one frame per message'
    consumeClaudeLines(state, `${assistant(answer)}\n`)
    expect(state.text).toBe(answer)
    expect(state.sawDeltas).toBe(false)
  })

  it('keeps a half-written line for the next read instead of dropping it', () => {
    const state = fresh()
    const line = delta('split across reads')
    consumeClaudeLines(state, line.slice(0, 20))
    expect(state.text).toBe('')
    consumeClaudeLines(state, `${line.slice(20)}\n`)
    expect(state.text).toBe('split across reads')
  })
})
