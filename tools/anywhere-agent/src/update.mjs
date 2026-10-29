/**
 * Update policy, as pure functions.
 *
 * Electron's built-in updater is not usable here: it is Squirrel.Mac on macOS, and
 * the Electron documentation is explicit that automatic updates require a signed
 * app, while signing for distribution requires an Apple Developer account and
 * Xcode. So this client ships its own updater, and the parts that carry risk -
 * comparing versions, validating a channel manifest, deciding whether to move, and
 * verifying that a downloaded payload is the one the manifest promised - are pure
 * functions with tests.
 *
 * What this module deliberately does not do: install. Replacing an application
 * bundle while it is running is a privileged, platform-specific step, and it is
 * the one step that must be revisited when the app is signed for distribution.
 */

/** The update channel manifest, as published. */
const REQUIRED_FIELDS = ['version', 'url', 'sha256'];

/**
 * Parses and validates a channel manifest.
 *
 * A manifest is untrusted input: it arrives over the network, so every field is
 * checked before it can influence a download.
 *
 * @param {unknown} input parsed JSON, or a string of it
 * @returns {{ ok: true, manifest: object } | { ok: false, reason: string }}
 */
export function parseManifest(input) {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, reason: 'manifest is not valid JSON' };
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'manifest is not an object' };
  }
  for (const field of REQUIRED_FIELDS) {
    if (typeof value[field] !== 'string' || value[field].trim() === '') {
      return { ok: false, reason: `manifest is missing ${field}` };
    }
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$/.test(value.version)) {
    return { ok: false, reason: `manifest version is not a version: ${value.version}` };
  }
  // The payload is fetched over the network; only https may carry it.
  if (!/^https:\/\//.test(value.url)) {
    return { ok: false, reason: 'manifest url must be https' };
  }
  const hex = value.sha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return { ok: false, reason: 'manifest sha256 must be 64 hex characters' };
  }
  const minProtocol = value.minProtocol === undefined ? 0 : Number(value.minProtocol);
  if (!Number.isInteger(minProtocol) || minProtocol < 0) {
    return { ok: false, reason: 'manifest minProtocol must be a non-negative integer' };
  }
  return {
    ok: true,
    manifest: {
      version: value.version,
      url: value.url,
      sha256: hex,
      minProtocol,
      notes: typeof value.notes === 'string' ? value.notes : '',
      required: value.required === true,
    },
  };
}

/**
 * Compares two dotted versions, numerically per component.
 *
 * @returns {number} positive when a is newer, negative when older, 0 when equal
 */
export function compareVersions(a, b) {
  const parts = (value) =>
    String(value)
      .split(/[.-]/)
      .map((piece) => (/^[0-9]+$/.test(piece) ? Number(piece) : piece));
  const left = parts(a);
  const right = parts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) {
      // Left ran out of components. A trailing number means left is the shorter,
      // older version; a trailing label means right is a pre-release, and a release
      // outranks its own pre-release.
      return typeof y === 'number' ? -1 : 1;
    }
    if (y === undefined) {
      return typeof x === 'number' ? 1 : -1;
    }
    if (x === y) continue;
    const xNum = typeof x === 'number';
    const yNum = typeof y === 'number';
    if (xNum && yNum) return x - y;
    // A numeric component outranks a pre-release label (1.0.0 > 1.0.0-rc).
    if (xNum) return 1;
    if (yNum) return -1;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

/**
 * Decides what to do about a manifest.
 *
 * `refuse` is the important one: a client whose protocol is older than the
 * manifest demands must not install, because the agent and the shell only work
 * together at the same protocol revision.
 *
 * @param {{ current: string, protocol: number, manifest: object }} input
 * @returns {{ action: 'none' | 'available' | 'refuse', reason: string }}
 */
export function decideUpdate(input) {
  const manifest = input?.manifest;
  if (!manifest || typeof manifest !== 'object') {
    return { action: 'none', reason: 'no manifest' };
  }
  const protocol = Number(input?.protocol ?? 0);
  const minProtocol = Number(manifest.minProtocol ?? 0);
  if (minProtocol > protocol) {
    return {
      action: 'refuse',
      reason: `this build speaks protocol ${protocol}, the update needs ${minProtocol}`,
    };
  }
  const order = compareVersions(manifest.version, input?.current ?? '0.0.0');
  if (order > 0) {
    return { action: 'available', reason: `${manifest.version} is newer than ${input.current}` };
  }
  return { action: 'none', reason: 'already current' };
}

/**
 * Constant-time-ish comparison of two hex digests.
 *
 * A mismatch must never install, so the comparison does not stop at the first
 * differing character.
 *
 * @param {string} actual hex digest of what was downloaded
 * @param {string} expected hex digest from the manifest
 * @returns {boolean}
 */
export function digestMatches(actual, expected) {
  const a = String(actual ?? '')
    .trim()
    .toLowerCase();
  const b = String(expected ?? '')
    .trim()
    .toLowerCase();
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** How often a window that stays open re-asks the channel about itself. */
export const UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * Whether the channel should be asked again.
 *
 * The check used to run once, at launch, and nothing ever ran it again: a client left
 * open for days kept reporting the update state it read on the first morning. The
 * interval is deliberately long - this is a background fact, not a poll the user asked
 * for - and a failed check still counts as a check, so an unreachable channel cannot
 * turn into a retry loop.
 *
 * @param {object} input
 * @param {number} input.lastCheckedAt when the channel was last asked (0: never).
 * @param {number} input.now the decision time.
 * @param {number} [input.intervalMs] how stale a reading may be; defaults to
 *   {@link UPDATE_RECHECK_MS}.
 * @returns {boolean} true when the caller should ask again
 */
export function updateCheckDue({ lastCheckedAt, now, intervalMs = UPDATE_RECHECK_MS }) {
  if (!Number.isFinite(lastCheckedAt) || lastCheckedAt <= 0) {
    // Launch has its own check; the heartbeat only ages a reading that exists.
    return false;
  }
  return now - lastCheckedAt >= intervalMs;
}

/**
 * Asks the channel what the current version should be.
 *
 * The fetch is injected so the decision is testable without a network, and the
 * channel is only ever https: an update channel that can be redirected in transit
 * is a way to run someone else's code on every machine that trusts us.
 *
 * Installing is deliberately not here. Replacing a running application bundle is a
 * privileged, platform-specific step, and it is the step that must be revisited
 * when the app is signed for distribution.
 *
 * @param {{
 *   channel: string,
 *   current: string,
 *   protocol: number,
 *   fetchImpl?: (url: string) => Promise<{ ok: boolean, status?: number, text: () => Promise<string> }>,
 * }} options
 * @returns {Promise<{ action: 'none' | 'available' | 'refuse' | 'error', reason: string, manifest?: object }>}
 */
export async function checkForUpdate(options) {
  const channel = String(options?.channel ?? '').trim();
  if (channel === '') {
    return { action: 'none', reason: 'no update channel configured' };
  }
  if (!/^https:\/\//.test(channel)) {
    return { action: 'error', reason: 'the update channel must be https' };
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { action: 'error', reason: 'no fetch implementation available' };
  }
  let response;
  try {
    response = await fetchImpl(channel);
  } catch (error) {
    return { action: 'error', reason: `the update channel could not be reached: ${error.message}` };
  }
  if (!response || response.ok !== true) {
    return { action: 'error', reason: `the update channel answered ${response?.status ?? 'nothing'}` };
  }
  let body;
  try {
    body = await response.text();
  } catch (error) {
    return { action: 'error', reason: `the update channel response could not be read: ${error.message}` };
  }
  const parsed = parseManifest(body);
  if (!parsed.ok) {
    return { action: 'error', reason: parsed.reason };
  }
  const decision = decideUpdate({ current: options.current, protocol: options.protocol, manifest: parsed.manifest });
  return { ...decision, manifest: parsed.manifest };
}

/**
 * Checks the engine's self-reported identity against the contract this build was
 * written against. The agent and the shell are updated independently, so a
 * mismatch has to be a loud refusal rather than a half-working overlay.
 *
 * @param {{ protocol?: number, netbird?: string, helper?: string } | null} reported
 * @param {{ protocol: number, netbird: string, helper: string }} contract
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkContract(reported, contract) {
  if (!reported || typeof reported !== 'object') {
    return { ok: false, reason: 'the engine did not report its version' };
  }
  if (Number(reported.protocol) !== Number(contract.protocol)) {
    return {
      ok: false,
      reason: `engine protocol ${reported.protocol} does not match the required ${contract.protocol}`,
    };
  }
  // Semver build metadata (the `+dirty` our patched tree reports) is explicitly not
  // part of precedence, and rejecting our own engine over it would be absurd.
  const base = (value) => String(value ?? '').split('+')[0].trim();
  if (base(reported.netbird) !== base(contract.netbird)) {
    return {
      ok: false,
      reason: `engine is netbird ${reported.netbird}, this build requires ${contract.netbird}`,
    };
  }
  return { ok: true, reason: 'engine matches the contract' };
}