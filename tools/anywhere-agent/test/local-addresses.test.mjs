import { test } from 'node:test';
import assert from 'node:assert/strict';

import { interfaceAddresses, localAddresses } from '../src/local-addresses.mjs';

/** The shape `os.networkInterfaces()` returns, trimmed to the fields that matter here. */
const INTERFACES = {
  lo0: [
    { address: '127.0.0.1', family: 'IPv4', internal: true },
    { address: '::1', family: 'IPv6', internal: true },
  ],
  en0: [{ address: '192.168.111.32', family: 'IPv4', internal: false }],
  utun100: [
    { address: '100.64.1.81', family: 'IPv4', internal: false },
    { address: 'fd55:9840:d387:b9b3:c4f9:34da:d167:b7f7', family: 'IPv6', internal: false },
  ],
  utun0: [{ address: 'fe80::8eab:2eb5:ef12:1ab5', family: 'IPv6', internal: false }],
};

test('this machine is its addresses, loopback and all excluded', () => {
  // A fleet record names a machine by an overlay address; loopback names nothing a record
  // could carry, so it is not an identity of this machine.
  const addresses = interfaceAddresses(INTERFACES);
  assert.ok(addresses.includes('100.64.1.81'), 'the overlay address the fleet knows this machine by');
  assert.ok(addresses.includes('192.168.111.32'));
  assert.ok(!addresses.includes('127.0.0.1'));
  assert.ok(!addresses.includes('::1'));
  // Duplicates collapse, so the identity set cannot depend on interface enumeration order.
  assert.equal(new Set(addresses).size, addresses.length);
});

test('the engine address counts too, since its userspace stack has no interface', () => {
  const addresses = localAddresses({ ip: '100.64.1.93', ipv6: 'fd55:9840:d387:b9b3:1a44:809f:8777:688' }, INTERFACES);
  assert.ok(addresses.includes('100.64.1.93'), 'this app’s own enrollment is also this machine');
  assert.ok(addresses.includes('100.64.1.81'), 'the machine’s own client is still this machine');
  // Prefixes and zone ids are normalized away: records and interfaces write them differently.
  const normalized = localAddresses({ ip: '100.64.1.93/16' }, { utun1: [{ address: 'fe80::1%en0', internal: false }] });
  assert.deepEqual(normalized.sort(), ['100.64.1.93', 'fe80::1'].sort());
});

test('no interfaces and no engine report is an empty identity, not a wrong one', () => {
  assert.deepEqual(interfaceAddresses({}), []);
  assert.deepEqual(interfaceAddresses(null), []);
  assert.deepEqual(localAddresses(null, {}), []);
  assert.deepEqual(localAddresses({ ip: '', ipv6: undefined }, {}), []);
});
