/**
 * Fleet configuration: the one place that names the addresses this app needs.
 *
 * The APK compiles a single bootstrap origin (plus one overlay fallback) and
 * reads everything else from `fleet.json` on the update channel. That is the
 * lesson of the 2026-10 fleet rename: `apk.dl-dev` had been compiled into both
 * the update check and the connect-time health probe, so retiring that DNS zone
 * left an app whose tunnel was up but which could never report "network usable"
 * again. A compiled address is a dependency on a name nobody can change without
 * shipping a new APK, so there is exactly one of them per transport path and
 * every one of them is a fallback, never the only answer.
 *
 * Two names are deliberately NOT here, because moving them under a remote
 * document would be a lie about what they are:
 *
 * - the NetBird management URL: the address in force is the user's own choice
 *   when they made one, else the compiled default, and the native side owns both
 *   (`NetBirdRuntime.kt` plus `NetBirdServerPreferences.kt`). What is mirrored
 *   here is the fleet's record of its own control plane, held equal to that
 *   compiled default by a test rather than read at runtime: a bootstrap document
 *   must not be able to silently re-point an enrolled install at another
 *   account.
 * - the fleet DNS zone: Android's cleartext policy is a build-time resource, so
 *   the zone name has to be compiled (`res/values/fleet_dsh_zones.xml`, held to
 *   tools/dsh-netbird/machines.json by `pnpm dsh-netbird:mobile-registry`).
 */

import {
  APK_BASE_URL,
  BOOTSTRAP_CONFIG_URLS as GENERATED_BOOTSTRAP_CONFIG_URLS,
  DSH_ZONES,
  MANAGEMENT_URL,
  MANIFEST_URL,
} from './generated/fleetConfig';

export type FleetConfig = {
  /**
   * The fleet's own control plane, for the channel document's record. The
   * address this install enrolls against is read from the native server store
   * (which falls back to the compiled default), not from this document.
   */
  managementUrl: string;
  /** Version manifest for the in-app update check. */
  manifestUrl: string;
  /** Base URL the manifest's relative `apkUrl` is resolved against. */
  apkBaseUrl: string;
  /** Fleet DSH DNS zone (mirrors the compiled `fleet_dsh_zones.xml`). */
  zone: string;
};

/**
 * Compiled fallbacks. They must point at live endpoints: the app uses them
 * before `fleet.json` can be read, and whenever the channel is unreachable.
 *
 * Every value comes from `config/fleet.json` through
 * `scripts/render-fleet-config.mjs`; this file only holds the shapes and the
 * remote-document rules, so a deployment changes one config file instead of
 * three clients.
 */
export const DEFAULT_FLEET_CONFIG: FleetConfig = {
  managementUrl: MANAGEMENT_URL,
  manifestUrl: MANIFEST_URL,
  apkBaseUrl: APK_BASE_URL,
  zone: DSH_ZONES[0],
};

/**
 * Bootstrap origins tried in order. The first is the public HTTPS name (works
 * on ordinary WiFi, needs no NetBird and no cleartext exception); the second is
 * the same document over the overlay, so an enrolled device that cannot reach
 * the public name can still be reconfigured.
 */
export const BOOTSTRAP_CONFIG_URLS: string[] = [...GENERATED_BOOTSTRAP_CONFIG_URLS];

/** A bootstrap fetch is a hint, never a gate: give up quickly and keep going. */
export const BOOTSTRAP_TIMEOUT_MS = 8000;

const URL_FIELDS: (keyof FleetConfig)[] = ['managementUrl', 'manifestUrl', 'apkBaseUrl'];
const ZONE_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

let current: FleetConfig = DEFAULT_FLEET_CONFIG;
let loadedFromRemote = false;

/** The configuration in force. Always usable: defaults until a fetch lands. */
export function getFleetConfig(): FleetConfig {
  return current;
}

/** True once `fleet.json` was read successfully (diagnostics/tests). */
export function fleetConfigLoadedFromRemote(): boolean {
  return loadedFromRemote;
}

/**
 * Merges one remote document over the defaults. Unknown keys are ignored and a
 * malformed value falls back to the default for that key rather than rejecting
 * the whole document, so a partial `fleet.json` can never make the app worse
 * than the compiled state.
 */
export function mergeFleetConfig(raw: unknown): FleetConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const source = raw as Record<string, unknown>;
  const merged: FleetConfig = {...DEFAULT_FLEET_CONFIG};
  let accepted = 0;
  for (const field of URL_FIELDS) {
    const value = source[field];
    if (typeof value === 'string' && isHttpUrl(value)) {
      merged[field] = value.trim();
      accepted += 1;
    }
  }
  const zone = source.zone;
  if (typeof zone === 'string' && ZONE_PATTERN.test(zone.trim().toLowerCase())) {
    merged.zone = zone.trim().toLowerCase();
    accepted += 1;
  }
  return accepted > 0 ? merged : null;
}

export function isHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

type FetchLike = (input: string) => Promise<{ok?: boolean; status?: number; text(): Promise<string>}>;

/**
 * Reads `fleet.json` from the first bootstrap origin that answers, and returns
 * the configuration in force. Never throws and never blocks the caller for
 * longer than one bootstrap timeout: callers keep using the compiled defaults
 * if every origin fails, which is the state an offline first launch is in.
 */
export async function loadFleetConfig(fetchImpl?: FetchLike): Promise<FleetConfig> {
  const doFetch: FetchLike | null =
    fetchImpl ?? (typeof fetch === 'function' ? (fetch as unknown as FetchLike) : null);
  if (!doFetch) {
    return current;
  }
  for (const url of BOOTSTRAP_CONFIG_URLS) {
    try {
      const response = await withDeadline(doFetch(url), BOOTSTRAP_TIMEOUT_MS);
      if (response && response.ok === false) {
        continue;
      }
      const parsed = mergeFleetConfig(JSON.parse(await response.text()));
      if (parsed) {
        current = parsed;
        loadedFromRemote = true;
        return current;
      }
    } catch {
      // Try the next origin; a missing channel is a normal offline condition.
    }
  }
  return current;
}

/** Test seam: forget a previously loaded document. */
export function resetFleetConfig(): void {
  current = DEFAULT_FLEET_CONFIG;
  loadedFromRemote = false;
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fleet config timeout after ${ms}ms`)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}