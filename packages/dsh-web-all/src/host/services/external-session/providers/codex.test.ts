/**
 * Codex adapter: live progress, and the text a turn keeps when it is cut short.
 *
 * A turn used to be observed only after its process exited, so a cancelled
 * dispatch returned nothing at all. These tests script the process port locally
 * (the shared doubles cover the store and the fake adapter, not a growing stdout)
 * so a turn can be watched the way a real one is: the stream grows while `done`
 * stays pending, and a cancellation lands in the middle of it.
 */
import { describe, expect, it } from 'vitest'
import {
  TURN_TAIL_MAX_CHARS,
  type ExternalAdapterDeps,
  type ExternalOutputReader,
  type ExternalProcessHandle,
  type ExternalProcessOutcome,
  type ExternalProcessPort,
  type ExternalSpawnSpec,
  type TurnProgress,
} from '../../../../core/external-session/adapters.ts'
import { createCodexAdapter } from './codex.ts'

const THREAD_ID = '0199a213-81c0-7800-8aa1-bbab2a035a53'

/** One JSONL frame, newline included: the unit a poll loop must decode. */
function frame(event: unknown): string {
  return `${JSON.stringify(event)}\n`
}

/**
 * Wait until the scenario has caught up with the adapter.
 *
 * Progress is published from a timer, so a test cannot know a poll happened by
 * inspecting its own call stack: it yields the event loop until the condition
 * holds and fails with the label when the adapter never got there.
 */
async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** A stream over fixed text: the whole retained text, no cursor of its own. */
function fixedStream(text: string): ExternalOutputReader {
  return {
    readFrom(fromByte: number) {
      const offset = Math.min(fromByte, text.length)
      return { text: text.slice(offset), nextOffset: text.length, lossy: false }
    },
  }
}

/**
 * A collected stdout that grows the way a live one does.
 *
 * `write` is the CLI emitting; `slide` makes the next read report a slid window,
 * which is the only way the adapter's lossy branch is reachable from a test.
 */
interface ScriptedStream extends ExternalOutputReader {
  /** Append CLI output; the next read serves it as a delta. */
  write(chunk: string): void
  /** Make the next read return only the last `chars` of the stream, as a slid window does. */
  slide(chars: number): void
  /** Reads served so far; a poll has happened once this advances. */
  readonly reads: number
}

function scriptedStream(): ScriptedStream {
  let buffered = ''
  let retained: number | undefined
  let reads = 0
  return {
    get reads() {
      return reads
    },
    write(chunk) {
      buffered += chunk
    },
    slide(chars) {
      retained = chars
    },
    readFrom(fromByte) {
      reads += 1
      if (retained !== undefined) {
        const chars = retained
        retained = undefined
        // The subprocess reader documents a lossy read as the whole retained tail
        // plus the offset it ends at: the head of the stream is gone.
        return { text: buffered.slice(-chars), nextOffset: buffered.length, lossy: true }
      }
      const offset = Math.min(fromByte, buffered.length)
      return { text: buffered.slice(offset), nextOffset: buffered.length, lossy: false }
    },
  }
}

/** A process port whose single child exits when the test settles it. */
interface LivePort extends ExternalProcessPort {
  readonly calls: ExternalSpawnSpec[]
  settle(outcome: ExternalProcessOutcome): void
}

function livePort(stdout: ExternalOutputReader, stderr: ExternalOutputReader = fixedStream('')): LivePort {
  const calls: ExternalSpawnSpec[] = []
  let resolveDone: (outcome: ExternalProcessOutcome) => void = () => {}
  const done = new Promise<ExternalProcessOutcome>((resolve) => { resolveDone = resolve })
  return {
    calls,
    async resolveExecutable() { return '/usr/local/bin/codex' },
    spawn(spec) {
      calls.push(spec)
      const handle: ExternalProcessHandle = {
        done,
        collected: { stdout, stderr },
        terminate() {},
        async waitForExit() { return true },
      }
      return handle
    },
    settle(outcome) { resolveDone(outcome) },
  }
}

/** A process port whose child has already exited before the turn is read. */
function exitedPort(stdout: string, exitCode: number | null = 0, stderr = ''): ExternalProcessPort {
  return {
    async resolveExecutable() { return '/usr/local/bin/codex' },
    spawn(): ExternalProcessHandle {
      return {
        done: Promise.resolve({ exitCode, signal: null }),
        collected: { stdout: fixedStream(stdout), stderr: fixedStream(stderr) },
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
}

/** Adapter deps with the turn's clock under the test's control. */
function deps(port: ExternalProcessPort, now: () => number = () => 1_000): ExternalAdapterDeps {
  return {
    process: port,
    readTextFile: async () => null,
    homeDir: '/home/example',
    now,
    cancelGraceMs: 3_000,
  }
}

function adapterFor(port: ExternalProcessPort, now?: () => number) {
  return createCodexAdapter(deps(port, now), { bin: 'codex' })
}

describe('codex live progress', () => {
  it('reports frames, tool calls and a growing tail while the process runs', async () => {
    const stream = scriptedStream()
    const port = livePort(stream)
    const reports: TurnProgress[] = []
    const clock = { value: 1_000 }
    const running = adapterFor(port, () => clock.value).runTurn({
      prompt: 'hi',
      cwd: '/tmp',
      report: (progress) => { reports.push(progress) },
    })

    // `thread.started` and `turn.started` are progress: the second one used to be
    // dropped entirely, and a frame is the only evidence that a slow turn is alive
    // rather than dead.
    stream.write(frame({ type: 'thread.started', thread_id: THREAD_ID }) + frame({ type: 'turn.started' }))
    await until(() => reports.length === 1, 'the first progress report')
    expect(reports[0]).toMatchObject({ frames: 2, toolCalls: 0, chars: 0, tail: '', lastFrameAt: 1_000 })

    clock.value = 2_000
    // The last line is deliberately unfinished: its frame must be decoded once it
    // ends, not skipped and not counted twice across two polls.
    stream.write(
      frame({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls' } })
      + frame({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'draft-1' } })
      + frame({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'draft-2' } })
      + '{"type":"item.completed","item":{"id":"i4","type":"agent_mess',
    )
    await until(() => reports.length === 2, 'the second progress report')
    expect(reports[1]).toMatchObject({ frames: 5, toolCalls: 1, chars: 14, tail: 'draft-1draft-2', lastFrameAt: 2_000 })

    clock.value = 3_000
    stream.write('age","text":"ANSWER"}}\n')
    await until(() => reports.length === 3, 'the third progress report')
    expect(reports[2]).toMatchObject({ frames: 6, toolCalls: 1, chars: 20, tail: 'draft-1draft-2ANSWER', lastFrameAt: 3_000 })

    clock.value = 5_000
    stream.write(frame({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }))
    port.settle({ exitCode: 0, signal: null })
    const outcome = await running
    expect(outcome.status).toBe('completed')
    // A settled turn keeps its terminal frame's message, which is the LAST agent
    // message rather than the accumulated drafts.
    expect(outcome.result).toBe('ANSWER')
    expect(outcome.usage).toEqual({ input: 5, output: 2 })
    expect(outcome.durationMs).toBe(4_000)
    expect('partial' in outcome).toBe(false)
  })

  it('returns the accumulated text with partial set when the turn is cancelled before its terminal frame', async () => {
    const stream = scriptedStream()
    const port = livePort(stream)
    const reports: TurnProgress[] = []
    const controller = new AbortController()
    const running = adapterFor(port).runTurn({
      prompt: 'hi',
      cwd: '/tmp',
      signal: controller.signal,
      report: (progress) => { reports.push(progress) },
    })

    stream.write(
      frame({ type: 'thread.started', thread_id: THREAD_ID })
      + frame({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'HALF-ANSWER' } }),
    )
    await until(() => reports.length === 1, 'the progress report before the cancel')
    expect(reports[0]?.tail).toBe('HALF-ANSWER')

    controller.abort()
    port.settle({ exitCode: null, signal: 'SIGTERM' })
    const outcome = await running
    expect(outcome.status).toBe('aborted')
    expect(outcome.result).toBe('HALF-ANSWER')
    expect(outcome.partial).toBe(true)
    // The conversation id survives the cancel, so the session stays continuable.
    expect(outcome.providerSessionId).toBe(THREAD_ID)
  })

  it('keeps the produced text on a cancel that lands before the first poll', async () => {
    // A turn can exit inside one poll interval, so the settle read — not the
    // accumulator — is what makes the partial answer exist in that case.
    const controller = new AbortController()
    controller.abort()
    const outcome = await adapterFor(exitedPort(
      frame({ type: 'thread.started', thread_id: THREAD_ID })
      + frame({ type: 'item.completed', item: { type: 'agent_message', text: 'FAST-ANSWER' } }),
    )).runTurn({ prompt: 'hi', cwd: '/tmp', signal: controller.signal })
    expect(outcome.status).toBe('aborted')
    expect(outcome.result).toBe('FAST-ANSWER')
    expect(outcome.partial).toBe(true)
  })

  it('leaves partial absent and the terminal message intact on a normal settle', async () => {
    const stdout = frame({ type: 'thread.started', thread_id: THREAD_ID })
      + frame({ type: 'turn.started' })
      + frame({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'CODEX-OK' } })
      + frame({ type: 'turn.completed', usage: { input_tokens: 17_607, output_tokens: 8 } })
    // A ticking clock proves the turn settles without a poll: one reading at the
    // start and one at the settle, so the duration is exactly one step.
    let ticks = 0
    const outcome = await adapterFor(exitedPort(stdout), () => 1_000 + 500 * ticks++)
      .runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(outcome.status).toBe('completed')
    expect(outcome.result).toBe('CODEX-OK')
    expect(outcome.usage).toEqual({ input: 17_607, output: 8 })
    expect(outcome.providerSessionId).toBe(THREAD_ID)
    expect(outcome.durationMs).toBe(500)
    expect('partial' in outcome).toBe(false)
  })

  it('keeps the terminal message when the cancel lands after the turn completed', async () => {
    const controller = new AbortController()
    controller.abort()
    const outcome = await adapterFor(exitedPort(
      frame({ type: 'thread.started', thread_id: THREAD_ID })
      + frame({ type: 'item.completed', item: { type: 'agent_message', text: 'DONE' } })
      + frame({ type: 'turn.completed' }),
    )).runTurn({ prompt: 'hi', cwd: '/tmp', signal: controller.signal })
    expect(outcome.status).toBe('aborted')
    // A terminal frame was seen, so there is nothing partial about this text.
    expect(outcome.result).toBe('DONE')
    expect('partial' in outcome).toBe(false)
  })

  it('does not duplicate text when the retained window slides', async () => {
    const stream = scriptedStream()
    const port = livePort(stream)
    const reports: TurnProgress[] = []
    const running = adapterFor(port).runTurn({
      prompt: 'hi',
      cwd: '/tmp',
      report: (progress) => { reports.push(progress) },
    })

    const first = frame({ type: 'thread.started', thread_id: THREAD_ID })
      + frame({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'AAA' } })
    stream.write(first)
    await until(() => reports.length === 1, 'the progress report before the slide')
    expect(reports[0]).toMatchObject({ frames: 2, chars: 3, tail: 'AAA' })

    const second = frame({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'BBB' } })
    stream.write(second)
    // The window slid past everything read so far, so the next read carries the
    // whole retained tail — including the frame already accumulated. Appending it
    // would count 'AAA' twice; the adapter rebuilds from the tail instead.
    stream.slide(first.length + second.length)
    await until(() => reports.length === 2, 'the progress report after the slide')
    expect(reports[1]?.chars).toBe(6)
    expect(reports[1]?.tail).toBe('AAABBB')

    stream.write(frame({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }))
    port.settle({ exitCode: 0, signal: null })
    const outcome = await running
    expect(outcome.status).toBe('completed')
    expect(outcome.result).toBe('BBB')
  })

  it('bounds the reported tail to the END of the answer', async () => {
    const long = `${'a'.repeat(TURN_TAIL_MAX_CHARS)}TAIL-END`
    const stream = scriptedStream()
    const port = livePort(stream)
    const reports: TurnProgress[] = []
    const running = adapterFor(port).runTurn({
      prompt: 'hi',
      cwd: '/tmp',
      report: (progress) => { reports.push(progress) },
    })
    // Two frames, so the turn settles normally while the answer under test is far
    // longer than the cap.
    stream.write(
      frame({ type: 'item.completed', item: { type: 'agent_message', text: long } })
      + frame({ type: 'turn.completed' }),
    )
    await until(() => reports.length === 1, 'the bounded progress report')
    expect(reports[0]?.chars).toBe(long.length)
    expect(reports[0]?.tail).toHaveLength(TURN_TAIL_MAX_CHARS)
    expect(reports[0]?.tail.endsWith('TAIL-END')).toBe(true)
    port.settle({ exitCode: 0, signal: null })
    const outcome = await running
    expect(outcome.status).toBe('completed')
    expect(outcome.result).toBe(long)
  })

  it('survives a progress callback that throws', async () => {
    const stream = scriptedStream()
    const port = livePort(stream)
    let reported = 0
    const running = adapterFor(port).runTurn({
      prompt: 'hi',
      cwd: '/tmp',
      report: () => {
        reported += 1
        // Progress is bookkeeping: a caller's callback is not allowed to turn a
        // healthy process into a failed turn.
        throw new Error('progress sink is full')
      },
    })
    stream.write(frame({ type: 'thread.started', thread_id: THREAD_ID }))
    await until(() => reported === 1, 'the throwing progress report')
    stream.write(
      frame({ type: 'item.completed', item: { type: 'agent_message', text: 'ANSWER' } })
      + frame({ type: 'turn.completed' }),
    )
    port.settle({ exitCode: 0, signal: null })
    const outcome = await running
    expect(outcome.status).toBe('completed')
    expect(outcome.result).toBe('ANSWER')
  })
})

describe('codex partial text on a failed turn', () => {
  it('returns the produced text instead of the exit diagnostic when a turn failed after answering', async () => {
    const stdout = frame({ type: 'thread.started', thread_id: THREAD_ID })
      + frame({ type: 'item.completed', item: { type: 'agent_message', text: 'PARTIAL-WORK' } })
      + frame({ type: 'turn.failed', error: { message: 'stream disconnected before completion' } })
    const outcome = await adapterFor(exitedPort(stdout, 1, 'boom')).runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(outcome.status).toBe('failed')
    expect(outcome.result).toBe('PARTIAL-WORK')
    expect(outcome.partial).toBe(true)
    expect(outcome.status === 'failed' ? outcome.error?.code : null).toBe('provider-error')
  })

  it('falls back to the exit diagnostic when a failed turn produced no text', async () => {
    // The exit facts are the only actionable thing here, so they must not be lost
    // to the partial rule.
    const outcome = await adapterFor(exitedPort(
      frame({ type: 'turn.failed', error: { message: 'stream disconnected' } }),
      1,
      'boom',
    )).runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(outcome.status).toBe('failed')
    expect(outcome.result).toContain('exit 1')
    expect(outcome.result).toContain('boom')
    expect('partial' in outcome).toBe(false)
  })

  it('reads a final line that arrived without its newline', async () => {
    // After exit the stream is over, so a trailing fragment is a whole frame; the
    // poll loop cannot assume that, because for it the same fragment may be the
    // first half of a line the next write finishes.
    const stdout = frame({ type: 'thread.started', thread_id: THREAD_ID })
      + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'NO-NEWLINE' } })
    const outcome = await adapterFor(exitedPort(stdout, 1)).runTurn({ prompt: 'hi', cwd: '/tmp' })
    expect(outcome.status).toBe('failed')
    expect(outcome.result).toBe('NO-NEWLINE')
    expect(outcome.partial).toBe(true)
  })
})