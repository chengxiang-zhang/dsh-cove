/**
 * Discovery for the fleet overlay: which machines of this private network expose
 * a DSH workspace, and under which canonical name.
 *
 * The acceptance decision is a pure function of three inputs the embedded engine
 * hands over: the DNS records distributed in the fleet's zones, the overlay
 * addresses of every peer this client knows about, and the declared zone list.
 * Names alone never grant access — a record is offered only when it points at a
 * peer of this network, so a peer that receives names it cannot reach (which is
 * what zone-wide distribution does) still sees nothing it cannot use.
 *
 * This mirrors `DshHostRegistry.selectAcceptedDsh` / `acceptedDshName`
 * (tools/netbird-client/android/app/src/main/java/com/netbirdportal/DshHostRegistry.kt).
 */

import { canonicalRecordName, isCloudZone, machineOfCanonical } from './netbird-names.mjs';

/** DNS record type A. Only A records name a machine address. */
const RECORD_TYPE_A = 1;

/** First label of every fleet DSH entry. */
const ENTRY_LABEL = 'dsh';

/**
 * The schemes one fleet entry is tried on, secure first.
 *
 * A capability that asks for a real permission - microphone capture for voice
 * input is the one that surfaced this - exists only in a secure context, and a
 * machine that has installed its certificate material answers on TLS. Not every
 * machine has that entry yet, and the mobile client stays on the plaintext entry
 * on purpose (its engine keeps its own root store), so plaintext remains the
 * fallback rather than being replaced. Which scheme answered is a runtime fact,
 * so it is decided by the probe and not by a name.
 */
export const ENTRY_URL_SCHEMES = ['https', 'http']

/**
 * Every URL one entry may answer on, in the order they are tried.
 *
 * @param {string} host canonical authority
 * @returns {string[]}
 */
export function entryCandidateUrls(host) {
  return ENTRY_URL_SCHEMES.map((scheme) => `${scheme}://${host}/`)
}

/**
 * Canonical name of one acceptable fleet DSH entry, otherwise null.
 *
 * One decision, used for the registry, the openable page and the probe, so the
 * three cannot disagree.
 *
 * @param {{ type?: number, name?: string, zone?: string, content?: string }} record
 * @param {string[]} fleetZones declared DSH zones
 * @param {Set<string> | string[]} peerAddresses overlay addresses of this network
 * @returns {string | null}
 */
export function acceptedDshName(record, fleetZones, peerAddresses, options = {}) {
  const peers = peerAddresses instanceof Set ? peerAddresses : new Set(peerAddresses ?? []);
  const zones = Array.isArray(fleetZones) ? fleetZones : [];

  if (!record || record.type !== RECORD_TYPE_A) {
    return null;
  }
  const canonical = canonicalRecordName(record.name, record.zone);
  if (canonical === null) {
    return null;
  }
  if (options.cloud === true) {
    // Cloud peers answer under their own FQDN (`<peer>.netbird.cloud`). A
    // record is a candidate when it names one peer of this network under the
    // cloud zone; the probe decides whether that peer actually serves a DSH
    // workspace, so phones and plain peers drop out of the list on their own.
    const zone = String(record.zone ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (!isCloudZone(zone) || !canonical.endsWith(`.${zone}`)) {
      return null;
    }
    // The network map may carry the name zone-relative (`peer-a`) or as the
    // FQDN (`peer-a.netbird.cloud`); both qualify to the same canonical name,
    // which must be exactly one peer label in front of the zone.
    const relative = canonical.slice(0, -(zone.length + 1));
    if (relative === '' || relative.includes('.')) {
      return null;
    }
    const address = String(record.content ?? '').trim().split('/')[0];
    if (address === '' || !peers.has(address)) {
      return null;
    }
    return canonical;
  }
  if (canonical.split('.')[0] !== ENTRY_LABEL) {
    return null;
  }
  // The entry must live in a declared DSH zone. A retired per-machine zone names
  // the same machine but is no longer the canonical authority, so it is not
  // offered.
  if (!zones.some((zone) => canonical.endsWith(`.${zone}`))) {
    return null;
  }
  // A DSH name has a machine label between `dsh` and the zone, so a record
  // literally named `dsh` is not one.
  const remainder = canonical.slice(`${ENTRY_LABEL}.`.length);
  if (!remainder.includes('.')) {
    return null;
  }
  const machine = remainder.slice(0, remainder.lastIndexOf('.'));
  if (machine === '') {
    return null;
  }
  // A DNS answer never carries a prefix; a peer state may (100.64.0.11/16).
  const address = String(record.content ?? '').trim().split('/')[0];
  if (address === '' || !peers.has(address)) {
    return null;
  }
  return canonical;
}

/**
 * Builds the machine registry offered to the user.
 *
 * @param {Array<{ type?: number, name?: string, zone?: string, content?: string }>} records
 * @param {Set<string> | string[]} peerAddresses
 * @param {string[]} fleetZones
 * @returns {{ entries: Array<{ host: string, machine: string, zone: string, ip: string, url: string }>, rejected: number }}
 */
export function buildRegistry(records, peerAddresses, fleetZones, options = {}) {
  const peers = peerAddresses instanceof Set ? peerAddresses : new Set(peerAddresses ?? []);
  const zones = Array.isArray(fleetZones) ? fleetZones : [];
  const byHost = new Map();
  let rejected = 0;

  for (const record of Array.isArray(records) ? records : []) {
    const host = acceptedDshName(record, zones, peers, options);
    if (host === null) {
      rejected += 1;
      continue;
    }
    if (byHost.has(host)) {
      continue;
    }
    const ip = String(record.content ?? '').trim().split('/')[0];
    const urls = entryCandidateUrls(host);
    byHost.set(host, {
      host,
      machine: options.cloud === true ? host.split('.')[0] : machineOfCanonical(host),
      zone: options.cloud === true
        ? host.split('.').slice(1).join('.')
        : zones.find((zone) => host.endsWith(`.${zone}`)) ?? '',
      ip,
      // The plaintext entry stays the default `url`: a consumer that never probes
      // reads exactly what it read before a TLS entry existed.
      url: urls[urls.length - 1],
      urls,
    });
  }

  const entries = [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host));
  return { entries, rejected };
}

/**
 * Normalized root URL when the address is exactly one accepted entry.
 *
 * Anything else — another intranet name, a public host, a raw IP, a sub-path, a
 * non-default port, another scheme — is refused, so a hostile link inside a
 * workspace page cannot redirect the client at an arbitrary destination.
 *
 * @param {string | null | undefined} rawUrl
 * @param {Set<string> | string[]} trustedHosts
 * @returns {string | null}
 */
export function registeredServiceUrl(rawUrl, trustedHosts) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return null;
  }
  const trusted = trustedHosts instanceof Set ? trustedHosts : new Set(trustedHosts ?? []);
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!trusted.has(host)) {
    return null;
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    return null;
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return null;
  }
  const defaultPort = scheme === 'http' ? 80 : 443;
  if (parsed.port !== '' && Number(parsed.port) !== defaultPort) {
    return null;
  }
  return `${scheme}://${host}/`;
}

/**
 * The overlay addresses of every peer this client knows about, connected and
 * offline alike.
 *
 * Offline peers stay in the set on purpose: "is this one of our machines" and
 * "is it up right now" are different questions, and only the second belongs to a
 * probe.
 *
 * @param {Array<{ ip?: string, ipv6?: string }>} peers
 * @returns {string[]}
 */
export function peerAddressSet(peers) {
  const seen = new Set();
  for (const peer of Array.isArray(peers) ? peers : []) {
    for (const value of [peer?.ip, peer?.ipv6]) {
      const host = String(value ?? '').trim().split('/')[0];
      if (host !== '') {
        seen.add(host);
      }
    }
  }
  return [...seen];
}