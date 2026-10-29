import { test } from 'node:test';
import assert from 'node:assert/strict';

import { APP_SCOPE_INVARIANTS, auditAppScope, isLoopbackHost } from '../src/app-scope.mjs';

/** The state a compliant client reports: embedded, userspace, no system surface. */
const CLEAN = {
  engine: 'embedded',
  interfaceType: 'Userspace',
  systemDnsDomains: [],
  clientRoutesApplied: false,
  exposesSystemInterface: false,
  proxyAddress: '127.0.0.1:19002',
  stateDirectory: '/Users/someone/Library/Application Support/AnywhereWork',
  sharedProfileDirectory: '/etc/netbird',
};

test('a compliant client passes every invariant', () => {
  const result = auditAppScope(CLEAN);
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('every invariant fails loudly on its own mutation', () => {
  /** Each case names the invariant it must trip and the one field it mutates. */
  const cases = [
    ['engine-embedded', { engine: 'system-daemon' }],
    ['interface-userspace', { interfaceType: 'Kernel' }],
    ['no-system-dns', { systemDnsDomains: ['netbird'] }],
    ['no-client-routes', { clientRoutesApplied: true }],
    ['no-system-interface', { exposesSystemInterface: true }],
    ['loopback-proxy', { proxyAddress: '0.0.0.0:19002' }],
    ['private-state', { stateDirectory: '' }],
    ['private-state', { stateDirectory: '/etc/netbird' }],
  ];
  for (const [id, mutation] of cases) {
    const result = auditAppScope({ ...CLEAN, ...mutation });
    assert.equal(result.ok, false, id);
    assert.deepEqual(
      result.violations.map((violation) => violation.id),
      [id],
    );
    assert.ok(result.violations[0].remedy.length > 20, 'a violation must carry a concrete remedy');
  }
});

test('an unknown state is not silently accepted', () => {
  const result = auditAppScope({});
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, APP_SCOPE_INVARIANTS.length);
});

test('the invariants all carry a title, a detail and a remedy', () => {
  for (const invariant of APP_SCOPE_INVARIANTS) {
    assert.ok(invariant.id && invariant.title && invariant.detail && invariant.remedy, invariant.id);
  }
});

test('loopback detection accepts only the loopback forms', () => {
  for (const address of ['127.0.0.1:19002', '127.0.0.1', '127.5.5.5:1', 'localhost:8080', '::1', '[::1]:19002']) {
    assert.equal(isLoopbackHost(address), true, address);
  }
  for (const address of ['0.0.0.0:19002', '100.64.1.81:19002', '', undefined, '192.168.1.5', '[fd55::1]:80']) {
    assert.equal(isLoopbackHost(address), false, String(address));
  }
});