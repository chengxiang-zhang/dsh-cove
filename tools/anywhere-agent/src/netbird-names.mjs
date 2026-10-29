/**
 * DNS name handling for the fleet overlay.
 *
 * This mirrors `DshHostRegistry.canonicalRecordName`
 * (tools/netbird-client/android/app/src/main/java/com/netbirdportal/DshHostRegistry.kt)
 * so the desktop agent and the mobile portal derive the same canonical name from
 * the same record. Two clients, one rule: a display name that one side accepts
 * and the other rejects would let the two disagree about which machines exist.
 */

import { CLOUD_DNS_DOMAIN as CLOUD_DNS_DOMAIN_VALUE } from './generated/fleetConfig.mjs';

/**
 * Lower-cases a DNS name and strips the root dot.
 *
 * @param {unknown} value
 * @returns {string} normalized name, or an empty string when the input is not a string
 */
export function normalizeDnsName(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Canonical name of one DNS record, qualified against its own zone.
 *
 * A name that already carries the zone is kept as-is. The NetBird internal zone
 * `netbird.selfhosted` and zone-root records carry no fleet meaning and yield
 * null.
 *
 * @param {string} name record name as the network map carries it (`dsh.laptop-b` or the FQDN)
 * @param {string} zone zone the record was distributed in
 * @returns {string | null} canonical name, or null when the record is not nameable
 */
export function canonicalRecordName(name, zone) {
  const normalizedZone = normalizeDnsName(zone);
  const normalizedName = normalizeDnsName(name);
  if (normalizedZone === '' || normalizedZone === 'netbird.selfhosted') {
    return null;
  }
  if (normalizedName === '' || normalizedName === normalizedZone) {
    return null;
  }
  return normalizedName.endsWith(`.${normalizedZone}`)
    ? normalizedName
    : `${normalizedName}.${normalizedZone}`;
}

/**
 * The machine label inside a canonical DSH name: `dsh.<machine>.<zone>`.
 *
 * One rule, used by the registry and by this machine's own row, so the two cannot label
 * the same authority differently.
 *
 * @param {unknown} host canonical DSH name
 * @returns {string} the machine label, or an empty string when the name has no room for one
 */
export function machineOfCanonical(host) {
  const labels = normalizeDnsName(host).split('.');
  return labels.length >= 3 ? labels.slice(1, -1).join('.') : '';
}

/** The DNS domain NetBird Cloud assigns when an account keeps the default. */
export { CLOUD_DNS_DOMAIN } from './generated/fleetConfig.mjs';

/**
 * Whether a DNS zone belongs to NetBird Cloud.
 *
 * Cloud accounts receive their peers under `<account>.netbird.cloud`; a custom
 * account DNS domain is not recognised here, which only means such an account
 * has to set its own zone (self-hosted-style) in the fleet intent.
 *
 * @param {unknown} zone
 * @returns {boolean}
 */
export function isCloudZone(zone) {
  const normalized = normalizeDnsName(zone);
  return normalized === CLOUD_DNS_DOMAIN_VALUE || normalized.endsWith(`.${CLOUD_DNS_DOMAIN_VALUE}`);
}
