/**
 * Wire constants shared by the host and browser halves of remote access.
 *
 * They live in `core/` because the served boot row (host half) and the client
 * trust patch (browser half) must agree byte-for-byte on the paths and on the
 * provenance marker cookie; `src/client/trust.ts` cannot import the host half.
 * @module dsh-web-all/core/remote-access/paths
 */

/** Parser-blocking boot script path; the host decides per request. */
export const HOST_ACCESS_BOOT_PATH = '/web-all/remote-access/boot.js'

/** Credential-free posture readout for one requesting Host. */
export const HOST_ACCESS_SESSION_PATH = '/api/dsh-access/session'

/** Browser-readable provenance marker: "this Host was an admitted entry". */
export const HOST_ACCESS_MARKER_COOKIE = 'dsh_access_host'

/** The only value the marker carries; anything else means "not marked". */
export const HOST_ACCESS_MARKER_VALUE = '1'

/** Marker lifetime; mirrors the gateway marker. */
export const HOST_ACCESS_MARKER_MAX_AGE_SECONDS = 30 * 24 * 3600