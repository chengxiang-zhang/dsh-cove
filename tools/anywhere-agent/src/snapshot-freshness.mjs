/**
 * Freshness of the machine list itself.
 *
 * The list answers three questions that change while nobody touches the app: can this
 * client reach the machine, does it hold finished work the user has not seen, and is
 * the app's own engine still alive. None of the three is pushed by anything - the host
 * pushes notices only when a page asks, and a dead engine answers nothing at all - so a
 * window that reads the list once, or only when someone presses refresh, keeps claiming
 * the answer it got at launch. That is the same failure as a frozen workspace page, one
 * layer up, and it is why the shell reads the list on a heartbeat.
 *
 * Two derived decisions live here as well, because both are about not throwing away
 * state on a momentary answer:
 *
 *   - A machine that drops out of the list is usually a probe that timed out, not a
 *     machine that is gone. Its page is kept until it has been missing for a while, and
 *     only then destroyed.
 *   - The session proxy belongs to the engine. When the engine is gone the proxy must be
 *     cleared, or every request the window makes is sent into a dead loopback port and
 *     the app looks broken rather than disconnected.
 *
 * @module snapshot-freshness
 */

/** How old a machine-list reading may be before the shell re-reads it. */
export const SNAPSHOT_HEARTBEAT_MS = 45_000;

/** The same age while the window is hidden: nobody is looking, so the probes can wait. */
export const SNAPSHOT_HEARTBEAT_HIDDEN_MS = 5 * 60 * 1000;

/** How long a machine may be missing from the list before its resident page is dropped. */
export const VIEW_PRUNE_GRACE_MS = 10 * 60 * 1000;

/**
 * How stale a machine-list reading may get before it is re-read.
 *
 * Reading the list costs two requests per machine, so a window nobody is looking at does
 * not need the watched interval: it keeps the answer fresh enough that opening the window
 * is not a step backwards, and the dots it would have grown are still there when the user
 * comes back. The tick that calls this is derived from the value, so a window that becomes
 * visible again tightens the interval on its next tick.
 *
 * @param {object} input
 * @param {boolean} input.visible whether the window is on screen.
 * @param {number} [input.visibleMs] the watched interval.
 * @param {number} [input.hiddenMs] the hidden interval.
 * @returns {number} the maximum age of a reading, in milliseconds
 */
export function snapshotHeartbeatMs({
  visible,
  visibleMs = SNAPSHOT_HEARTBEAT_MS,
  hiddenMs = SNAPSHOT_HEARTBEAT_HIDDEN_MS,
}) {
  return visible ? visibleMs : hiddenMs;
}

/**
 * Whether the heartbeat should read the machine list now.
 *
 * @param {object} input
 * @param {number} input.lastReadAt when the list was last read (0: never).
 * @param {number} input.now the decision time.
 * @param {boolean} [input.inFlight] a read is already running.
 * @param {boolean} [input.paused] scripted/offline reads are authoritative instead.
 * @param {number} [input.heartbeatMs] the maximum age; defaults to {@link SNAPSHOT_HEARTBEAT_MS}.
 * @returns {boolean} true when the caller should re-read the list
 */
export function shouldReadSnapshotOnHeartbeat({
  lastReadAt,
  now,
  inFlight = false,
  paused = false,
  heartbeatMs = SNAPSHOT_HEARTBEAT_MS,
}) {
  if (inFlight || paused) {
    return false;
  }
  if (!Number.isFinite(lastReadAt) || lastReadAt <= 0) {
    return false;
  }
  return now - lastReadAt >= heartbeatMs;
}

/**
 * The resident pages of machines that have been missing from the list long enough to stop
 * being a probe failure.
 *
 * @param {object} input
 * @param {Iterable<string>} input.known hosts the current reading lists.
 * @param {Iterable<string>} input.open hosts that still have a resident page.
 * @param {Record<string, number>} [input.missingSince] when each host was first seen
 *   missing; hosts without an entry are being seen missing for the first time.
 * @param {number} input.now the decision time.
 * @param {number} [input.graceMs] how long a missing host may keep its page.
 * @returns {string[]} the hosts whose pages should be destroyed
 */
export function viewsToPrune({ known, open, missingSince = {}, now, graceMs = VIEW_PRUNE_GRACE_MS }) {
  const live = new Set(known);
  const pruned = [];
  for (const host of open) {
    if (live.has(host)) {
      continue;
    }
    const since = missingSince[host];
    if (Number.isFinite(since) && now - since >= graceMs) {
      pruned.push(host);
    }
  }
  return pruned;
}

/**
 * Whether the session proxy must be cleared.
 *
 * `next` is what the current reading offers; an empty value means the engine that owned
 * the proxy is gone, and keeping the old rule would send the window's traffic into a dead
 * loopback port.
 *
 * @param {object} input
 * @param {string} input.applied the proxy currently installed on the session.
 * @param {string} input.next the proxy the current reading offers.
 * @returns {boolean} true when the proxy should be cleared
 */
export function shouldClearProxy({ applied, next }) {
  return String(applied ?? '') !== '' && String(next ?? '') === '';
}
