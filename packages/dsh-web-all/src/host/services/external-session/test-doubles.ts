/**
 * Test doubles for the external-session service domain.
 *
 * They live beside the code rather than in `tests/` because they are the domain's
 * own seams, spelled the way the production types are: a fake adapter is an
 * `ExternalAdapter`, so a change to the contract breaks these doubles at compile
 * time instead of drifting silently. The filename does not match the test glob,
 * so vitest never collects it as a suite.
 * @module dsh-web-all/host/services/external-session/test-doubles
 */
import type {
  ExternalAdapter, ExternalOutputReader, TurnOutcome, TurnProgress, TurnRequest,
} from '../../../core/external-session/adapters.ts'
import type { ExternalProvider } from '../../../core/external-session/types.ts'
import type { StoreFileSystem } from './store.ts'

/** One queued adapter turn the test has not settled yet. */
interface PendingTurn {
  request: TurnRequest
  resolve(outcome: TurnOutcome): void
  reject(error: unknown): void
}

/**
 * An adapter whose turns settle when the test says so.
 *
 * `autoOutcome` makes a turn settle immediately, which is what the sequential
 * tests want; leaving it out makes every turn hang until `settle`, which is what
 * the concurrency and cancellation tests need.
 */
export class FakeAdapter implements ExternalAdapter {
  readonly calls: TurnRequest[] = []
  /** Return value of `resolveExecutable`. */
  executable: string | null = '/fake/bin'
  /** Immediate outcome; when absent a turn stays pending until settled. */
  autoOutcome: ((request: TurnRequest) => TurnOutcome) | undefined
  /** When set, `runTurn` throws instead of resolving. */
  throws: Error | undefined
  /**
   * What a cancelled turn answers. A real CLI keeps the text it had already
   * written, which is the point of the partial path, so a test can model that.
   */
  cancelOutcome: Partial<TurnOutcome> | undefined
  private readonly pending: PendingTurn[] = []

  constructor(readonly provider: ExternalProvider = 'claude') {}

  async resolveExecutable(): Promise<string | null> {
    return this.executable
  }

  runTurn(request: TurnRequest): Promise<TurnOutcome> {
    this.calls.push(request)
    if (this.throws !== undefined) return Promise.reject(this.throws)
    if (this.autoOutcome !== undefined) return Promise.resolve(this.autoOutcome(request))
    return new Promise<TurnOutcome>((resolve, reject) => {
      const entry: PendingTurn = { request, resolve, reject }
      // A real CLI dies on SIGTERM and reports an aborted turn; modelling that
      // here is what lets a cancellation test observe the consequence rather
      // than assert on the signal and leave the turn hanging.
      const cancelled = (): void => {
        const at = this.pending.indexOf(entry)
        if (at === -1) return
        this.pending.splice(at, 1)
        resolve({
          status: 'aborted',
          result: 'cancelled',
          durationMs: 1,
          providerSessionId: 'cli-session-1',
          ...this.cancelOutcome,
        } as TurnOutcome)
      }
      if (request.signal?.aborted === true) {
        resolve({ status: 'aborted', result: 'cancelled', durationMs: 1, providerSessionId: 'cli-session-1' })
        return
      }
      request.signal?.addEventListener('abort', cancelled, { once: true })
      this.pending.push(entry)
    })
  }

  /** Turns started but not yet settled. */
  get inFlight(): number {
    return this.pending.length
  }

  /** The signal handed to the oldest unsettled turn. */
  get lastSignal(): AbortSignal | undefined {
    return this.pending[0]?.request.signal
  }

  /**
   * Publish progress for the oldest unsettled turn, the way a real adapter's
   * read loop does while its child process runs.
   */
  reportProgress(progress: TurnProgress): void {
    this.pending[0]?.request.report?.(progress)
  }

  /** Settle the oldest unsettled turn. */
  settle(outcome: Partial<TurnOutcome> & { status: TurnOutcome['status'] }): void {
    const turn = this.pending.shift()
    if (turn === undefined) throw new Error('no adapter turn is waiting to settle')
    turn.resolve({
      result: 'done',
      durationMs: 5,
      providerSessionId: 'cli-session-1',
      ...outcome,
    } as TurnOutcome)
  }

  /** Fail the oldest unsettled turn with a thrown error. */
  fail(error: unknown): void {
    const turn = this.pending.shift()
    if (turn === undefined) throw new Error('no adapter turn is waiting to fail')
    turn.reject(error)
  }
}

/** A store filesystem held in memory, with real read/write/rename semantics. */
export class MemoryStoreFileSystem implements StoreFileSystem {
  readonly files = new Map<string, string>()
  /** Paths written through `writeAtomic`, in order. */
  readonly writes: string[] = []
  /** Fail the next `writeAtomic` with this error. */
  failNextWrite: Error | undefined
  /** Fail every `writeAtomic`, the way an unwritable directory does. */
  failAllWrites: Error | undefined
  private gate: Promise<void> | undefined
  private openGate: (() => void) | undefined

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) this.files.set(path, content)
  }

  async readText(path: string): Promise<string | null> {
    return this.files.get(path) ?? null
  }

  /**
   * Hold every write until the returned release is called.
   *
   * This opens the window the panel hits: a turn whose record is still being
   * written, so "is it running?" and "is it on disk?" disagree for a moment.
   */
  holdWrites(): () => void {
    this.gate = new Promise<void>(resolve => { this.openGate = resolve })
    return () => {
      const open = this.openGate
      this.gate = undefined
      this.openGate = undefined
      open?.()
    }
  }

  async writeAtomic(path: string, content: string): Promise<void> {
    if (this.gate !== undefined) await this.gate
    if (this.failAllWrites !== undefined) throw this.failAllWrites
    if (this.failNextWrite !== undefined) {
      const error = this.failNextWrite
      this.failNextWrite = undefined
      throw error
    }
    this.writes.push(path)
    this.files.set(path, content)
  }

  async rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from)
    if (content === undefined) throw new Error(`ENOENT: ${from}`)
    this.files.delete(from)
    this.files.set(to, content)
  }
}

/** A reader over a fixed stream, for adapter-level doubles. */
export function fixedReader(text: string): ExternalOutputReader {
  return {
    readFrom(fromByte: number) {
      const offset = Math.min(fromByte, text.length)
      return { text: text.slice(offset), nextOffset: text.length, lossy: false }
    },
  }
}