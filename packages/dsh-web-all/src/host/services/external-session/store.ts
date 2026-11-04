/**
 * Durable session store: one JSON file, atomically replaced, bounded in size.
 *
 * The file outlives the host process, which is what makes a resumed CLI
 * conversation possible after a restart. Two properties carry that promise:
 * every write is a whole-file atomic replacement (a reader sees the old or the
 * new file, never a half-written one), and the in-memory state never diverges
 * from disk — a mutation that cannot be written is not reported as accepted.
 *
 * A file that fails validation is quarantined next to itself rather than
 * overwritten: the sessions in it are unrecoverable to this build but still the
 * user's data, and silently replacing them would be the one unrecoverable act
 * this module could commit.
 * @module dsh-web-all/host/services/external-session/store
 */
import { readFile, rename, stat } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  emptyExternalStore, parseExternalStoreText, serializeExternalStore,
} from '../../../core/external-session/schema.ts'
import type { ExternalSessionRecord, ExternalStoreFile } from '../../../core/external-session/types.ts'

/** How this store reaches the filesystem; injectable so a test uses a temp file. */
export interface StoreFileSystem {
  readText(path: string): Promise<string | null>
  writeAtomic(path: string, content: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

/** Private file mode: session records hold prompts and results. */
const STORE_FILE_MODE = 0o600
const STORE_DIR_MODE = 0o700

/** The real filesystem, used by the host service. */
export const nodeStoreFileSystem: StoreFileSystem = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  async writeAtomic(path, content) {
    await writeFileAtomic(path, content, { mode: STORE_FILE_MODE, dirMode: STORE_DIR_MODE })
  },
  async rename(from, to) {
    await rename(from, to)
  },
}

/** Store options. */
export interface ExternalSessionStoreOptions {
  storePath: string
  /** Maximum sessions retained; new sessions are refused at this size. */
  maxSessions: number
  /** Filesystem seam; defaults to the real one. */
  fs?: StoreFileSystem
  /** Warning outlet for a quarantined file. */
  onWarning?: (message: string) => void
  /** Clock for the quarantine suffix; defaults to `Date.now`. */
  now?: () => number
}

/**
 * The session store. One instance per host process; the in-memory copy is the
 * read path and every mutation is written through before it is reported.
 */
export class ExternalSessionStore {
  private state: ExternalStoreFile = emptyExternalStore()
  private loaded = false
  /** Serializes writes so two mutations cannot interleave their file replacement. */
  private writing: Promise<void> = Promise.resolve()
  private quarantinePath: string | null = null
  /** The filesystem seam, resolved once so no call site has to re-check it. */
  private readonly fs: StoreFileSystem
  /** Deterministic clock for the quarantine suffix. */
  private readonly now: () => number

  constructor(private readonly options: ExternalSessionStoreOptions) {
    this.fs = options.fs ?? nodeStoreFileSystem
    this.now = options.now ?? Date.now
  }

  /** Whether the store has been read from disk at least once. */
  get isLoaded(): boolean {
    return this.loaded
  }

  /** Where an unreadable file was moved, when one was. */
  get quarantinedPath(): string | null {
    return this.quarantinePath
  }

  /**
   * Read the file once. A missing file is an empty store; an unreadable one is
   * quarantined and also becomes an empty store, with a warning.
   * @returns the sessions now held.
   */
  async load(): Promise<ExternalSessionRecord[]> {
    if (this.loaded) return this.list()
    const text = await this.fs.readText(this.options.storePath)
    if (text === null) {
      this.state = emptyExternalStore()
      this.loaded = true
      return this.list()
    }
    const parsed = parseExternalStoreText(text)
    if (!parsed.ok) {
      const target = `${this.options.storePath}.corrupt-${this.now()}`
      try {
        await this.fs.rename(this.options.storePath, target)
        this.quarantinePath = target
        this.options.onWarning?.(`unreadable external-session store moved to ${target}: ${parsed.reason}`)
      } catch (error) {
        this.options.onWarning?.(`unreadable external-session store could not be moved aside: ${String(error)}`)
      }
      this.state = emptyExternalStore()
      this.loaded = true
      return this.list()
    }
    this.state = parsed.value
    this.loaded = true
    return this.list()
  }

  /** Every session, in stored order. */
  list(): ExternalSessionRecord[] {
    return [...this.state.sessions]
  }

  /** One session by id. */
  get(id: string): ExternalSessionRecord | undefined {
    return this.state.sessions.find(session => session.id === id)
  }

  /**
   * Whether one more session fits under the configured limit.
   *
   * Closing a session does not free a slot: closed records stay readable, and
   * the design deletes them from the panel.
   */
  canAdd(): boolean {
    return this.state.sessions.length < this.options.maxSessions
  }

  /** How many sessions are held. */
  get size(): number {
    return this.state.sessions.length
  }

  /**
   * Insert or replace one session and write the file.
   * @param session - the record to persist.
   * @throws when an insert would exceed the configured limit.
   */
  async upsert(session: ExternalSessionRecord): Promise<void> {
    await this.mutate(state => {
      const index = state.sessions.findIndex(current => current.id === session.id)
      if (index === -1 && state.sessions.length >= this.options.maxSessions) {
        throw Object.assign(new Error(`external session store is full (${this.options.maxSessions})`), { code: 'limit' })
      }
      const sessions = index === -1
        ? [...state.sessions, session]
        : state.sessions.map((current, at) => (at === index ? session : current))
      return { version: state.version, sessions }
    })
  }

  /**
   * Replace the whole set of sessions, used for a bulk change such as a purge.
   * @param sessions - the sessions the file should hold.
   */
  async replaceAll(sessions: readonly ExternalSessionRecord[]): Promise<void> {
    await this.mutate(state => ({ version: state.version, sessions: [...sessions] }))
  }

  /**
   * Apply one state change and commit it.
   *
   * The whole read-modify-write runs *inside* the write chain, not before it: a
   * caller that computed its next state from `this.state` on entry would race
   * every other caller still queued, and the last writer would silently drop
   * their sessions. The change is written first and adopted after, so a failed
   * write leaves the in-memory state at the last durable value rather than
   * reporting a session that never reached disk.
   */
  private async mutate(apply: (state: ExternalStoreFile) => ExternalStoreFile): Promise<void> {
    const run = this.writing.then(async () => {
      const next = apply(this.state)
      await this.fs.writeAtomic(this.options.storePath, serializeExternalStore(next))
      this.state = next
    })
    // Keep the chain alive for later writers even when this one rejects.
    this.writing = run.catch(() => {})
    await run
  }
}

/** Whether `path` is an existing directory, for the `cwd-invalid` preflight. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}