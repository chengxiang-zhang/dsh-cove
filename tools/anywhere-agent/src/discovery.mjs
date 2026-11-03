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
 * One fleet entry: the record's meaning, or null when it names no service of a
 * machine of this network.
 *
 * The fleet publishes one A record per (service, machine) pair under the zone:
 * `<service>.<machine>.<zone>`, for example `dsh.zcx-t470p.netbird`. The zone's
 * records are the catalogue, and nothing here enumerates services: adding
 * `superset.<machine>.<zone>` is a DNS record, not a client release. The first
 * label is the group a person thinks in, the second names the machine.
 *
 * The record must point at a peer of this network, so a name that resolves
 * outside the overlay is not offered.
 *
 * @param {{ type?: number, name?: string, zone?: string, content?: string }} record
 * @param {string[]} fleetZones zones this deployment distributes fleet names in
 * @param {Set<string> | string[]} peerAddresses overlay addresses of this network
 * @param {{ cloud?: boolean }} [options] which naming world the control plane uses
 * @returns {{ host: string, service: string, machine: string, zone: string, ip: string } | null}
 */
export function fleetEntryOf(record, fleetZones, peerAddresses, options = {}) {
  const peers = peerAddresses instanceof Set ? peerAddresses : new Set(peerAddresses ?? []);
  const zones = Array.isArray(fleetZones) ? fleetZones : [];

  if (!record || record.type !== RECORD_TYPE_A) {
    return null;
  }
  const canonical = canonicalRecordName(record.name, record.zone);
  if (canonical === null) {
    return null;
  }
  // A DNS answer never carries a prefix; a peer state may (100.64.0.11/16).
  const address = String(record.content ?? '').trim().split('/')[0];
  if (address === '' || !peers.has(address)) {
    return null;
  }
  if (options.cloud === true) {
    // Cloud peers answer under their own FQDN (`<peer>.netbird.cloud`); the
    // network map may carry the name zone-relative or as the FQDN, and both
    // qualify to one canonical name with exactly one peer label in front of the
    // cloud zone. A cloud name carries no service label, so its group is empty.
    const zone = String(record.zone ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (!isCloudZone(zone) || !canonical.endsWith(`.${zone}`)) {
      return null;
    }
    const relative = canonical.slice(0, -(zone.length + 1));
    if (relative === '' || relative.includes('.')) {
      return null;
    }
    return { host: canonical, service: '', machine: relative, zone, ip: address };
  }
  const zone = zones.find((candidate) => canonical.endsWith(`.${candidate}`));
  if (zone === undefined) {
    // A name outside the declared zones is another zone's business: a retired
    // per-machine zone names the same machine but is not the canonical authority.
    return null;
  }
  // `<service>.<machine>` is the whole of the name in front of the zone. Fewer
  // labels name no machine (`dsh.netbird`); more would leave it open which label
  // is the machine, so the record is refused rather than guessed.
  const parts = canonical.slice(0, -(zone.length + 1)).split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [service, machine] = parts;
  if (service === '' || machine === '') {
    return null;
  }
  return { host: canonical, service, machine, zone, ip: address };
}

/**
 * Builds the service registry offered to the user: every `<service>.<machine>`
 * entry the fleet publishes in its zones, sorted by host and deduplicated.
 *
 * @param {Array<{ type?: number, name?: string, zone?: string, content?: string }>} records
 * @param {Set<string> | string[]} peerAddresses
 * @param {string[]} fleetZones
 * @returns {{ entries: Array<{ host: string, service: string, machine: string, zone: string, ip: string, url: string, urls: string[] }>, rejected: number }}
 */
export function buildRegistry(records, peerAddresses, fleetZones, options = {}) {
  const peers = peerAddresses instanceof Set ? peerAddresses : new Set(peerAddresses ?? []);
  const zones = Array.isArray(fleetZones) ? fleetZones : [];
  const byHost = new Map();
  let rejected = 0;

  for (const record of Array.isArray(records) ? records : []) {
    const entry = fleetEntryOf(record, zones, peers, options);
    if (entry === null) {
      rejected += 1;
      continue;
    }
    if (byHost.has(entry.host)) {
      continue;
    }
    const urls = entryCandidateUrls(entry.host);
    byHost.set(entry.host, {
      ...entry,
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