/**
 * The answer path's own audit trail.
 *
 * Why this exists: the plugin's log lines do not reach disk on an installation whose
 * host does not capture them, so "why did it decide that" was unanswerable after the
 * fact - the ledger records what a job became, never why. Design notes and the
 * acceptance readings that depended on grepping those logs were therefore
 * unexecutable. This stream is owned by the answer path, appended next to the ledger
 * it describes, and written for exactly the decisions that are otherwise invisible.
 *
 * The rule that shapes every line of this file: an audit that can break an answer is
 * worse than no audit. A failure to write - a read-only directory, a full disk, a
 * detail object that cannot be serialised - costs one line and nothing else. Nothing
 * here throws, and nothing here may be called on a path whose only job is to send.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** The decisions worth recording, named for the moment rather than for the code. */
export type AuditEventName = 'admit' | 'steer' | 'turn' | 'send' | 'ack' | 'error'

/** One line of the trail. */
export interface AuditEvent {
  readonly event: AuditEventName
  /** The job this decision belongs to, when there is one. */
  readonly jobId?: string
  /** The conversation, truncated: the trail is readable, not authoritative. */
  readonly convKey?: string
  /** What was decided and why. Free-form so a new decision needs no schema change. */
  readonly detail?: Record<string, unknown>
}

/** The sink the answer path calls; it never throws and never reports back. */
export type AuditSink = (event: AuditEvent) => void

/** Current file, rotated sibling, and the size at which rotation happens. */
export const AUDIT_FILE = 'audit.jsonl'
export const AUDIT_ROTATED_FILE = 'audit.1.jsonl'
export const AUDIT_MAX_BYTES = 5 * 1024 * 1024

/** How much of a conversation key a line carries. */
export const AUDIT_CONV_KEY_CHARS = 40

/**
 * Truncate a conversation key for the trail.
 *
 * A chat id is long and the tail is the only part that distinguishes two of them; the
 * ledger remains the place to look one up exactly.
 * @param convKey - the conversation key.
 * @returns at most {@link AUDIT_CONV_KEY_CHARS} characters.
 */
export function auditConvKey(convKey: string): string {
  return convKey.length <= AUDIT_CONV_KEY_CHARS ? convKey : `${convKey.slice(0, AUDIT_CONV_KEY_CHARS)}…`
}

/**
 * Build the append-only sink for one directory.
 *
 * Rotation is checked before each append rather than on a timer: the file only needs
 * bounding, and a timer would be one more thing that can keep a process awake. One
 * generation is kept, because the trail answers "what just happened", not "what
 * happened last month" - the ledger and the daily JSONL shards cover history.
 * @param input - where to write, what clock to trust, and the size limit.
 * @returns a sink that never throws.
 */
export function createAuditSink(input: {
  dir: string
  now?: () => number
  maxBytes?: number
}): AuditSink {
  const path = join(input.dir, AUDIT_FILE)
  const rotated = join(input.dir, AUDIT_ROTATED_FILE)
  const maxBytes = input.maxBytes ?? AUDIT_MAX_BYTES
  const now = input.now ?? (() => Date.now())
  return (event: AuditEvent): void => {
    // Everything - serialisation included - is inside the guard. A detail object
    // carrying a BigInt or a cycle throws in `JSON.stringify`, and that must cost the
    // same single line as a full disk.
    try {
      const line = `${JSON.stringify({
        ts: new Date(now()).toISOString(),
        event: event.event,
        ...(event.jobId === undefined ? {} : { jobId: event.jobId }),
        ...(event.convKey === undefined ? {} : { convKey: auditConvKey(event.convKey) }),
        detail: event.detail ?? {},
      })}\n`
      // Rotation first, so a line is never written into a file that is about to be
      // renamed out from under it.
      try {
        if (statSync(path).size >= maxBytes) renameSync(path, rotated)
      } catch {
        // No file yet, or one that cannot be examined: appending will report the real
        // problem, and a failed rotation must not skip the line.
      }
      mkdirSync(input.dir, { recursive: true, mode: 0o700 })
      appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // Deliberately empty: see the file comment. Losing a line is the acceptable
      // failure; failing an answer is not.
    }
  }
}