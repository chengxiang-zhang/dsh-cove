import { test } from 'node:test';
import assert from 'node:assert/strict';

import { acceptedDshName, buildRegistry, entryCandidateUrls, peerAddressSet, registeredServiceUrl } from '../src/discovery.mjs';

const ZONES = ['netbird'];
const PEERS = ['100.64.1.81', '100.64.1.10'];

const CLOUD_PEERS = ['100.64.1.81', '100.64.1.10', '100.64.1.90'];

test('a zone-relative A record for a machine of this network is accepted', () => {
  const host = acceptedDshName(
    { type: 1, name: 'dsh.peer-a', zone: 'netbird', content: '100.64.1.81' },
    ZONES,
    PEERS,
  );
  assert.equal(host, 'dsh.peer-a.netbird');
});

test('a fully qualified record derives the same name', () => {
  const host = acceptedDshName(
    { type: 1, name: 'dsh.peer-a.netbird', zone: 'netbird', content: '100.64.1.81' },
    ZONES,
    PEERS,
  );
  assert.equal(host, 'dsh.peer-a.netbird');
});

test('a non-A record is never an entry', () => {
  assert.equal(
    acceptedDshName({ type: 5, name: 'dsh.peer-a', zone: 'netbird', content: '100.64.1.81' }, ZONES, PEERS),
    null,
  );
});

test('only names whose first label is dsh are entries', () => {
  // The fleet zone also carries internal service names (clickhouse.<machine>,
  // auth.<machine>, browserless-mcp.<machine>). None of them may reach the user's
  // machine list.
  for (const name of ['clickhouse.peer-a', 'auth.peer-a', 'browserless-mcp.peer-a', 'apk.peer-a']) {
    assert.equal(
      acceptedDshName({ type: 1, name, zone: 'netbird', content: '100.64.1.81' }, ZONES, PEERS),
      null,
      name,
    );
  }
});

test('a record named dsh is not a machine entry', () => {
  assert.equal(
    acceptedDshName({ type: 1, name: 'dsh', zone: 'netbird', content: '100.64.1.81' }, ZONES, PEERS),
    null,
  );
});

test('a retired per-machine zone is not the canonical authority', () => {
  assert.equal(
    acceptedDshName({ type: 1, name: 'dsh', zone: 'peer-a', content: '100.64.1.81' }, ZONES, PEERS),
    null,
  );
  assert.equal(
    acceptedDshName({ type: 1, name: 'dsh.peer-a', zone: 'peer-a', content: '100.64.1.81' }, ZONES, PEERS),
    null,
  );
});

test('an entry pointing outside this network is refused', () => {
  assert.equal(
    acceptedDshName({ type: 1, name: 'dsh.peer-c', zone: 'netbird', content: '100.64.1.11' }, ZONES, PEERS),
    null,
  );
  assert.equal(
    acceptedDshName({ type: 1, name: 'dsh.public', zone: 'netbird', content: '93.184.216.34' }, ZONES, PEERS),
    null,
  );
});

test('an overlay address carrying a prefix still matches a peer', () => {
  const host = acceptedDshName(
    { type: 1, name: 'dsh.peer-b', zone: 'netbird', content: '100.64.1.10/16' },
    ZONES,
    PEERS,
  );
  assert.equal(host, 'dsh.peer-b.netbird');
});

test('buildRegistry keeps accepted entries sorted, deduplicated and with their machine name', () => {
  const registry = buildRegistry(
    [
      { type: 1, name: 'dsh.peer-b', zone: 'netbird', content: '100.64.1.10' },
      { type: 1, name: 'dsh.peer-a.netbird', zone: 'netbird', content: '100.64.1.81' },
      { type: 1, name: 'dsh.peer-a', zone: 'netbird', content: '100.64.1.81' },
      { type: 1, name: 'clickhouse.peer-a', zone: 'netbird', content: '100.64.1.81' },
      { type: 1, name: 'dsh.peer-c', zone: 'netbird', content: '100.64.1.11' },
    ],
    PEERS,
    ZONES,
  );
  assert.deepEqual(
    registry.entries.map((entry) => entry.host),
    ['dsh.peer-a.netbird', 'dsh.peer-b.netbird'],
  );
  assert.deepEqual(
    registry.entries.map((entry) => entry.machine),
    ['peer-a', 'peer-b'],
  );
  assert.equal(registry.entries[0].url, 'http://dsh.peer-a.netbird/');
  assert.deepEqual(registry.entries[0].urls, ['https://dsh.peer-a.netbird/', 'http://dsh.peer-a.netbird/']);
  assert.equal(registry.rejected, 2);
});

test('a fleet entry is offered on TLS first, with plaintext as the fallback', () => {
  // The secure entry is what a capability with a real permission needs; plaintext
  // stays for machines that have no TLS entry yet and for the mobile client.
  assert.deepEqual(entryCandidateUrls('dsh.peer-a.netbird'), [
    'https://dsh.peer-a.netbird/',
    'http://dsh.peer-a.netbird/',
  ]);
});

test('peerAddressSet strips prefixes and deduplicates', () => {
  assert.deepEqual(
    peerAddressSet([
      { ip: '100.64.1.81/16', ipv6: 'fd55::1/64' },
      { ip: '100.64.1.81' },
      { ip: '' },
    ]).sort(),
    ['100.64.1.81', 'fd55::1'].sort(),
  );
});

test('a trusted entry opens, and everything else is refused', () => {
  const trusted = ['dsh.peer-a.netbird'];
  assert.equal(registeredServiceUrl('http://dsh.peer-a.netbird/', trusted), 'http://dsh.peer-a.netbird/');
  assert.equal(registeredServiceUrl('http://dsh.peer-a.netbird', trusted), 'http://dsh.peer-a.netbird/');
  for (const hostile of [
    'http://dsh.peer-a.netbird/deep/path',
    'http://dsh.peer-a.netbird:8080/',
    'http://dsh.peer-a.netbird/?x=1',
    'http://dsh.peer-b.netbird/',
    'http://100.64.1.81/',
    'http://example.com/',
    'file:///etc/passwd',
  ]) {
    assert.equal(registeredServiceUrl(hostile, trusted), null, hostile);
  }
});

test('cloud mode accepts a peer record under the cloud zone', () => {
  const options = { cloud: true };
  const relative = acceptedDshName(
    { type: 1, name: 'peer-a', zone: 'netbird.cloud', content: '100.64.1.81' },
    ZONES,
    CLOUD_PEERS,
    options,
  );
  assert.equal(relative, 'peer-a.netbird.cloud');
  // The embedded client synthesizes peer FQDNs from the peer table, so the
  // record may arrive already qualified.
  const qualified = acceptedDshName(
    { type: 1, name: 'peer-a.netbird.cloud', zone: 'netbird.cloud', content: '100.64.1.81' },
    ZONES,
    CLOUD_PEERS,
    options,
  );
  assert.equal(qualified, 'peer-a.netbird.cloud');
});

test('cloud mode refuses anything that is not one peer of this network', () => {
  const options = { cloud: true };
  assert.equal(acceptedDshName({ type: 1, name: 'dsh.peer-a', zone: 'netbird.cloud', content: '100.64.1.81' }, ZONES, CLOUD_PEERS, options), null);
  assert.equal(acceptedDshName({ type: 1, name: 'peer-a', zone: 'netbird', content: '100.64.1.81' }, ZONES, CLOUD_PEERS, options), null);
  assert.equal(acceptedDshName({ type: 1, name: 'peer-a', zone: 'netbird.cloud', content: '93.184.216.34' }, ZONES, CLOUD_PEERS, options), null);
});

test('cloud registry rows use the peer FQDN and its label', () => {
  const registry = buildRegistry(
    [
      { type: 1, name: 'peer-a', zone: 'netbird.cloud', content: '100.64.1.81' },
      { type: 1, name: 'peer-b', zone: 'netbird.cloud', content: '100.64.1.10' },
    ],
    CLOUD_PEERS,
    ZONES,
    { cloud: true },
  );
  assert.deepEqual(registry.entries.map((entry) => entry.host), ['peer-a.netbird.cloud', 'peer-b.netbird.cloud']);
  assert.deepEqual(registry.entries.map((entry) => entry.machine), ['peer-a', 'peer-b']);
  assert.equal(registry.entries[0].zone, 'netbird.cloud');
});
