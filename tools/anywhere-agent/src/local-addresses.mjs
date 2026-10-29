/**
 * Every address this machine holds.
 *
 * The list has to answer one question - which fleet row is this machine - and it must
 * answer it without names. Names cannot: one physical machine holds a name per client
 * that enrolled it (this host's own client, plus this app's), so comparing names either
 * matches none of them or all of them.
 *
 * Addresses can. A fleet row is a DNS record whose content is the overlay address of the
 * machine it names; an address belongs to exactly one machine. A record that points at an
 * address of this machine *is* this machine, whichever name it carries.
 *
 * @module anywhere-agent/local-addresses
 */

import { networkInterfaces } from 'node:os';

/** Normalizes one address the way a DNS answer carries it: no prefix, no zone. */
function bareAddress(value) {
  const text = String(value ?? '').trim();
  const withoutPrefix = text.split('/')[0];
  return withoutPrefix.replace(/%.*$/, '');
}

/**
 * This machine's addresses, as the operating system reports them.
 *
 * Loopback is excluded: no fleet record names a machine by it, and including it would let
 * a malformed record claim to be this machine. The overlay addresses the OS exposes -
 * the machine's own clients, like the one that publishes its DSH entry - are included,
 * which is what makes the fleet's record for this machine recognizable.
 *
 * @param {object} [interfaces] `os.networkInterfaces()` output, for tests
 * @returns {string[]} the addresses, without duplicates
 */
export function interfaceAddresses(interfaces = networkInterfaces()) {
  const addresses = new Set();
  for (const entries of Object.values(interfaces ?? {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || entry.internal === true) {
        continue;
      }
      const address = bareAddress(entry.address);
      if (address !== '' && address !== '127.0.0.1' && address !== '::1') {
        addresses.add(address);
      }
    }
  }
  return [...addresses];
}

/**
 * This machine's addresses as seen by the fleet: the OS interfaces plus whatever this
 * app's own engine reports, which lives in its userspace stack and never reaches the OS.
 *
 * @param {{ ip?: string, ipv6?: string } | null} self the fleet's record for this machine
 * @param {object} [interfaces] `os.networkInterfaces()` output, for tests
 * @returns {string[]} the addresses, without duplicates
 */
export function localAddresses(self = null, interfaces = networkInterfaces()) {
  const addresses = new Set(interfaceAddresses(interfaces));
  for (const value of [self?.ip, self?.ipv6]) {
    const address = bareAddress(value);
    if (address !== '') {
      addresses.add(address);
    }
  }
  return [...addresses];
}
