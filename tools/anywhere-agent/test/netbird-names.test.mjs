import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canonicalRecordName, normalizeDnsName } from '../src/netbird-names.mjs';

test('normalizeDnsName lower-cases, trims and strips the root dot', () => {
  assert.equal(normalizeDnsName('  DSH.Peer-A.NETBIRD.  '), 'dsh.peer-a.netbird');
  assert.equal(normalizeDnsName(undefined), '');
  assert.equal(normalizeDnsName(42), '');
});

test('a zone-relative record is qualified against its own zone', () => {
  assert.equal(canonicalRecordName('dsh.peer-a', 'netbird'), 'dsh.peer-a.netbird');
});

test('a fully qualified record is kept as-is', () => {
  assert.equal(canonicalRecordName('dsh.peer-a.netbird', 'netbird'), 'dsh.peer-a.netbird');
  assert.equal(canonicalRecordName('DSH.Peer-A.netbird.', 'netbird.'), 'dsh.peer-a.netbird');
});

test('the internal zone and zone-root records are not nameable', () => {
  assert.equal(canonicalRecordName('dsh.peer-a', 'netbird.selfhosted'), null);
  assert.equal(canonicalRecordName('peer-a', 'netbird.selfhosted'), null);
  assert.equal(canonicalRecordName('netbird', 'netbird'), null);
  assert.equal(canonicalRecordName('', 'netbird'), null);
  assert.equal(canonicalRecordName('dsh.peer-a', ''), null);
});