/**
 * The machine list: DNS decides which machines exist, a probe decides what to say
 * about each one.
 *
 * The fleet authors one canonical record per machine (`dsh.<machine>.<zone>`
 * pointing at a peer's overlay address). That record is the identity: it exists
 * only because a machine of this network claimed the name, and the client may not
 * invent one. Everything a probe adds - reachable right now, the deployment
 * declares this authority, work finished - is status: it changes what the row
 * says, never whether the row exists.
 *
 * That separation is the whole point. A probe is one HTTP request over a private
 * overlay, and it fails for reasons that have nothing to do with the machine being
 * gone (a stale plugin build, an untrusted certificate, a timeout, a deployment
 * that never passed `--trusted-host`). Dropping the row then makes the window
 * claim "you have no other machines" - a stronger and false statement - and it
 * leaves the person no way to tell a missing machine from one that answered badly.
 *
 * A row is therefore in one of two states: it answered, or it did not. What a
 * deployment declares about its own authority is the host's business, not a label
 * this window puts on the person's machine.
 *
 * @module anywhere-agent/machine-list
 */

/** What a row says about the service it names. */
export const MACHINE_STATUS = {
  /** Answered. */
  ready: 'ready',
  /** No answer to the probe: it was skipped, timed out, or was refused. */
  offline: 'offline',
  /**
   * This machine. The embedded engine cannot dial its own overlay address, so a
   * probe of a row that belongs to the machine the app runs on would always fail;
   * that failure says nothing about the service, and the row carries no verdict.
   */
  self: 'self',
};

/**
 * The status one probe result means.
 *
 * A probe that never ran and a probe that failed both read as offline; they are
 * the same fact for the person looking at the card. Everything else the probe
 * learns - the posture a deployment declares, the sign-in state, finished runs -
 * is detail on the card, never a verdict about whether the machine is usable.
 *
 * @param {{ reachable?: boolean } | null | undefined} probe
 * @returns {string} one of {@link MACHINE_STATUS}
 */
export function machineStatusOf(probe, local = false) {
  if (probe !== null && probe !== undefined && probe.reachable === true) {
    return MACHINE_STATUS.ready;
  }
  return local === true ? MACHINE_STATUS.self : MACHINE_STATUS.offline;
}

/** A non-negative count from a probe field, or zero. */
function countOf(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * One row: the registry entry with the probe's reading laid over it.
 *
 * @param {object} entry a registry entry (canonical host, machine name, overlay address)
 * @param {object | null | undefined} probe that entry's probe result, when one was taken
 * @returns {object} the row the window shows and a click opens
 */
export function machineRow(entry, probe) {
  const status = machineStatusOf(probe, entry?.local === true);
  const answered = status === MACHINE_STATUS.ready;
  return {
    ...entry,
    status,
    reachable: answered,
    posture: probe?.posture === true,
    declared: probe?.declared === true,
    // An offline row keeps the registry's plaintext candidate URL: the row is still
    // openable, and a machine that answers again should be opened on a URL it had.
    ...(answered && typeof probe?.url === 'string' && probe.url !== '' ? { url: probe.url } : {}),
    ...(Number.isFinite(probe?.statusCode) ? { statusCode: probe.statusCode } : {}),
    ...(typeof probe?.reason === 'string' && probe.reason !== '' ? { reason: probe.reason } : {}),
    unread: countOf(probe?.unread),
    unreadFailed: countOf(probe?.unreadFailed),
    latestNotice: probe?.latestNotice ?? null,
    latest: countOf(probe?.latest),
  };
}

/**
 * Every row of a registry, in registry order.
 *
 * @param {object[]} entries the registry's entries
 * @param {Map<string, object>} [probes] probe results keyed by canonical host; an
 *   entry with no result keeps the offline status rather than leaving the list
 * @returns {object[]} the rows
 */
export function machineRows(entries, probes) {
  const byHost = probes instanceof Map ? probes : new Map();
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.host === 'string' && entry.host !== '')
    .map((entry) => machineRow(entry, byHost.get(entry.host)));
}

/**
 * How many rows are in each status, for a section that wants to say.
 *
 * @param {object[]} rows the rows
 * @returns {{ ready: number, offline: number, total: number }}
 */
export function machineCounts(rows) {
  let ready = 0;
  let offline = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.status === MACHINE_STATUS.ready) {
      ready += 1;
    } else if (row.status === MACHINE_STATUS.offline) {
      offline += 1;
    }
  }
  return { ready, offline, total: Array.isArray(rows) ? rows.length : 0 };
}
