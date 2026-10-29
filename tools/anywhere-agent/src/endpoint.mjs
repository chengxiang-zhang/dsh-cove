/**
 * Where this client enrolls, and how that address is decided.
 *
 * The address in force is the user's own choice when they made one, else the address
 * an already-enrolled config carries, else the package's default, else a document on
 * the update channel. The last one may only seed an install that has none of the
 * others: a fetched document must not be able to silently re-point an install that is
 * already enrolled at another account. The mobile client records the same rule in
 * `tools/netbird-client/src/fleetConfig.ts`, and the two clients read the same
 * channel document so a deployment has one fact to publish rather than two.
 *
 * The placeholder is deliberately not an address. It is what a checkout with no
 * deployment value would otherwise dial, and dialling it costs the user a minute of
 * "connecting" followed by an engine error that never names the server. Resolution
 * therefore answers with an empty url rather than the placeholder, and the screen
 * asks for the address instead of pretending to search for machines.
 *
 * @module anywhere-agent/endpoint
 */

import {
  BOOTSTRAP_CONFIG_URLS as GENERATED_BOOTSTRAP_CONFIG_URLS,
  CLOUD_HOST_SUFFIXES,
  MANAGEMENT_URL,
} from './generated/fleetConfig.mjs';

/**
 * The address a build without a deployment value would otherwise dial.
 *
 * It stays exported because two places need to recognise it: the engine config an
 * older build may already have written it into, and the packaged default read back
 * from a bundle that was built without one.
 */
export const PLACEHOLDER_MANAGEMENT_URL = 'https://netbird.example.com:443';

/**
 * The control plane a build with no deployment value dials: NetBird Cloud.
 *
 * A self-hosted deployment overrides it through the usual sources (flag,
 * environment, the server field, or the channel document), so the default only
 * decides what an install that nobody configured does.
 */
export const DEFAULT_MANAGEMENT_URL = MANAGEMENT_URL;

/**
 * Whether an address is NetBird Cloud rather than a self-hosted control plane.
 *
 * Cloud and self-hosted deployments name their entries differently, so callers
 * that resolve machine names need the distinction, not just the URL.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCloudManagement(value) {
  const url = normalizeEndpoint(value);
  if (url === '') {
    return false;
  }
  try {
    const host = new URL(url).hostname.toLowerCase();
    return CLOUD_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

/**
 * The channel document, and the origins it is tried on.
 *
 * Identical to the mobile client's bootstrap list: the public name first, then the
 * same document over the overlay, so an enrolled machine that cannot reach the public
 * name is still reconfigurable.
 */
export const BOOTSTRAP_CONFIG_URLS = [...GENERATED_BOOTSTRAP_CONFIG_URLS];

/** A bootstrap fetch is a hint, never a gate: give up quickly and keep going. */
export const BOOTSTRAP_TIMEOUT_MS = 8000;

/** Trims an address and drops the trailing slashes a hand-typed value tends to carry. */
export function normalizeEndpoint(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().replace(/\/+$/, '');
}

/**
 * Whether an address may be dialled at all.
 *
 * An http(s) URL with a host, and not the placeholder: "not the placeholder" is part of
 * usability rather than a separate policy, because dialling it is exactly the failure
 * this module exists to prevent.
 */
export function endpointIsUsable(value) {
  const url = normalizeEndpoint(value);
  if (url === '' || url === normalizeEndpoint(PLACEHOLDER_MANAGEMENT_URL)) {
    return false;
  }
  if (!/^https?:\/\//i.test(url)) {
    return false;
  }
  try {
    return new URL(url).hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * The address stored in an engine config.
 *
 * The engine writes a Go `url.URL` as JSON, so the endpoint is the scheme and host of
 * that object rather than one string. A config that carries the placeholder answers
 * with an empty string: it records an attempt, not an enrollment.
 *
 * @param {unknown} config the parsed engine config
 * @returns {string} the address, or '' when there is none to use
 */
export function endpointFromEngineConfig(config) {
  const url = config && typeof config === 'object' ? config.ManagementURL : null;
  const scheme = url && typeof url === 'object' ? url.Scheme : '';
  const host = url && typeof url === 'object' ? url.Host : '';
  const candidate = typeof scheme === 'string' && typeof host === 'string' ? `${scheme}://${host}` : '';
  return endpointIsUsable(candidate) ? normalizeEndpoint(candidate) : '';
}

/**
 * The address a channel document records, or null when the document is unusable.
 *
 * A malformed value falls back to "no answer" rather than to the placeholder, so a
 * partial document can never make the client worse than it already is.
 *
 * @param {unknown} raw the parsed JSON document
 * @returns {{ managementUrl: string } | null}
 */
export function mergeBootstrapDocument(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const value = raw.managementUrl;
  if (typeof value !== 'string' || !endpointIsUsable(value)) {
    return null;
  }
  return { managementUrl: normalizeEndpoint(value) };
}

/** How each address was obtained, for the diagnostics block and the panel's wording. */
export const ENDPOINT_SOURCES = ['flag', 'environment', 'choice', 'enrolled', 'bundled', 'channel', 'default', 'none'];

/**
 * Decides the address in force.
 *
 * Order is by how explicit the source is, with one deliberate exception: an address
 * this install already enrolls against outranks the package default. A user who is
 * signed in must not be moved to another account because a newer bundle was built
 * against a different address; changing it stays an explicit act (a flag, or the
 * server field in the window).
 *
 * @param {{
 *   flag?: string, env?: string, choice?: string, bundled?: string,
 *   engine?: string, seed?: string,
 * }} sources
 * @returns {{ url: string, defaultUrl: string, isCustom: boolean, source: string }}
 */
export function resolveEndpoint(sources = {}) {
  const flag = normalizeEndpoint(sources.flag);
  const env = normalizeEndpoint(sources.env);
  const choice = normalizeEndpoint(sources.choice);
  const bundled = normalizeEndpoint(sources.bundled);
  const engine = normalizeEndpoint(sources.engine);
  const seed = normalizeEndpoint(sources.seed);

  const packagedDefault = endpointIsUsable(bundled) ? bundled : DEFAULT_MANAGEMENT_URL;
  const steps = [
    ['flag', flag],
    ['environment', env],
    ['choice', choice],
    ['enrolled', engine],
    ['bundled', bundled],
    ['channel', seed],
    ['default', DEFAULT_MANAGEMENT_URL],
  ];
  const decided = steps.find(([, value]) => endpointIsUsable(value)) ?? ['none', ''];
  const url = endpointIsUsable(decided[1]) ? decided[1] : '';
  // "Custom" is what the mobile client's `（自建）` marks: an address that is not the
  // default this package ships. The default is reported either way, so the window can
  // show both facts when they differ.
  return {
    url,
    defaultUrl: packagedDefault,
    isCustom: url !== '' && url !== packagedDefault,
    source: url === '' ? 'none' : decided[0],
  };
}

/** The host a person recognises, for a row that has no room for the whole address. */
export function endpointHostLabel(url) {
  try {
    return new URL(normalizeEndpoint(url)).host;
  } catch {
    return '';
  }
}

/** How long a window with nothing to dial waits before re-reading the channel document. */
export const ENDPOINT_RETRY_MS = 60_000;

/**
 * Whether the channel document is worth reading again.
 *
 * It is read at launch, when the network is often the least ready thing on the machine:
 * a first launch right after wake or on a dead link leaves the window asking for an
 * address that the channel does publish. Asking again is cheap and bounded, but only
 * while there is nothing to dial - once the client has an address, an enrolled identity
 * outranks the channel and re-reading it could move a signed-in machine to another
 * account.
 *
 * @param {object} input
 * @param {boolean} input.hasEndpoint whether the client already has an address to dial.
 * @param {number} input.lastAttemptAt when the document was last read (0: never).
 * @param {number} input.now the decision time.
 * @param {number} [input.retryMs] minimum gap between reads; defaults to
 *   {@link ENDPOINT_RETRY_MS}.
 * @returns {boolean} true when the caller should read the document again
 */
export function shouldRetryEndpointDiscovery({ hasEndpoint, lastAttemptAt, now, retryMs = ENDPOINT_RETRY_MS }) {
  if (hasEndpoint) {
    return false;
  }
  if (!Number.isFinite(lastAttemptAt) || lastAttemptAt <= 0) {
    // Never read yet is the launch read's business, not the retry's.
    return false;
  }
  return now - lastAttemptAt >= retryMs;
}

/**
 * Reads the channel document and answers with the address it records.
 *
 * Never throws and never blocks the caller longer than one bootstrap timeout: an
 * offline first launch keeps the compiled default and asks the user, which is the
 * honest state for a machine that has never enrolled.
 *
 * @param {((input: string) => Promise<{ ok?: boolean, text(): Promise<string> }>) | undefined} fetchImpl
 * @returns {Promise<string>} the address, or '' when no origin answered
 */
export async function loadBootstrapEndpoint(fetchImpl) {
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) {
    return '';
  }
  for (const origin of BOOTSTRAP_CONFIG_URLS) {
    try {
      const response = await withDeadline(doFetch(origin), BOOTSTRAP_TIMEOUT_MS);
      if (response && response.ok === false) {
        continue;
      }
      const document = mergeBootstrapDocument(JSON.parse(await response.text()));
      if (document) {
        return document.managementUrl;
      }
    } catch {
      // Try the next origin; a missing channel is a normal offline condition.
    }
  }
  return '';
}

function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bootstrap timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}