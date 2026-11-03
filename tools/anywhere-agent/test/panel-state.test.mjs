import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_STATES,
  LOCAL_STATES,
  UI_STATES,
  localEntry,
  markLocalEntries,
  mergeEntries,
  provisioningCopy,
  uiState,
} from '../src/panel-state.mjs';

test('this machine not being ready outranks everything else', () => {
  // There is nothing to open and nothing to log into until the local host answers,
  // so no fleet reading may show through - not even a connected one.
  for (const state of ['checking', 'installing', 'starting', 'needs-runtime']) {
    assert.equal(uiState(state, 'off'), 'provisioning', state);
    assert.equal(uiState(state, 'ready'), 'provisioning', state);
    assert.equal(uiState(state, 'login-required'), 'provisioning', state);
  }
  // A local failure is the failure the user must see, whoever else is reachable.
  assert.equal(uiState('error', 'ready'), 'error');
  assert.equal(uiState('error', 'off'), 'error');
});

test('a working single machine needs no account', () => {
  // "off" is a destination, not a degraded state: this is the ordinary screen for
  // someone who never signs in.
  assert.equal(uiState('ready', 'off'), 'local');
  assert.equal(uiState('ready', ''), 'local');
  assert.equal(uiState('ready', undefined), 'local');
  assert.equal(uiState('ready', null), 'local');
});

test('the fleet half reports itself once the local host is up', () => {
  assert.equal(uiState('ready', 'starting'), 'connecting');
  assert.equal(uiState('ready', 'connecting'), 'connecting');
  assert.equal(uiState('ready', 'login-required'), 'login-required');
  assert.equal(uiState('ready', 'ready'), 'ready');
  assert.equal(uiState('ready', 'empty'), 'empty');
  assert.equal(uiState('ready', 'error'), 'error');
  // A word the engine invented is a failure, not a silent "connected".
  assert.equal(uiState('ready', 'nonsense'), 'error');
});

test('every state the window can render is reachable, and they are declared', () => {
  const reached = new Set([
    uiState('checking', 'off'),
    uiState('ready', 'off'),
    uiState('ready', 'connecting'),
    uiState('ready', 'login-required'),
    uiState('ready', 'ready'),
    uiState('ready', 'empty'),
    uiState('error', 'off'),
  ]);
  assert.deepEqual([...reached].sort(), [...UI_STATES].sort());
  // An unreadable reading is treated as "not ready yet" rather than as a success.
  assert.equal(uiState('nonsense', 'off'), 'provisioning');
  assert.equal(LOCAL_STATES.includes('ready'), true);
  assert.equal(FLEET_STATES.includes('off'), true);
});

test('each local step explains itself, including the one that hands work over', () => {
  for (const step of LOCAL_STATES) {
    const copy = provisioningCopy(step);
    assert.ok(copy.title.length > 0, step);
    assert.equal(typeof copy.body, 'string', step);
  }
  assert.equal(provisioningCopy('needs-install').title, '本机还没装好');
  assert.equal(provisioningCopy('nonsense').title, provisioningCopy('checking').title);
});

test('this machine is a row even with no network, no account and no records', () => {
  const row = localEntry({ machine: 'studio-mac', host: 'dsh.studio-mac.netbird', url: 'http://127.0.0.1:3080/' });
  assert.deepEqual(row, {
    host: 'dsh.studio-mac.netbird',
    service: 'dsh',
    machine: 'studio-mac',
    ip: '',
    url: 'http://127.0.0.1:3080/',
    statusCode: 200,
    local: true,
  });
  // A name without the two labels keeps the machine fact it was given, and claims no
  // service rather than inventing one.
  assert.deepEqual(localEntry({ machine: 'studio-mac', host: 'studio-mac' }), {
    host: 'studio-mac',
    service: '',
    machine: 'studio-mac',
    ip: '',
    url: '',
    statusCode: 200,
    local: true,
  });
});

test('one machine never appears twice, and the local reading wins', () => {
  const local = localEntry({ machine: 'studio-mac', host: 'dsh.studio-mac.netbird', url: 'http://127.0.0.1:3080/' });
  const fleet = [
    { host: 'dsh.studio-mac.netbird', machine: 'LeoDeMacBook-Pro.local', ip: '100.64.1.81' },
    { host: 'dsh.tower-lab.netbird', machine: 'tower-lab', ip: '100.64.1.74' },
  ];
  const merged = mergeEntries(local, fleet);
  assert.equal(merged.length, 2, 'the same physical machine is one row');
  assert.equal(merged[0], local, 'this machine comes first');
  assert.equal(merged[0].machine, 'studio-mac');
  assert.equal(merged[1].host, 'dsh.tower-lab.netbird');
});

test('the merge survives everything a wire can deliver', () => {
  assert.deepEqual(mergeEntries(null, []), []);
  assert.deepEqual(mergeEntries(null, undefined), []);
  assert.deepEqual(mergeEntries(localEntry({ host: '' }), []), [], 'a row with no host is not a row');
  const rows = mergeEntries(null, [
    { host: 'a' },
    null,
    'nonsense',
    { machine: 'no host' },
    { host: 'a', machine: 'duplicate' },
    { host: 'b' },
  ]);
  assert.deepEqual(rows.map((row) => row.host), ['a', 'b']);
});

test('every fleet record addressing this machine is marked local, one per service', () => {
  // One machine serves several services, so it holds one record per service; each is
  // this machine, and they stay separate rows because they are separate services.
  const fleet = [
    { host: 'dsh.studio-mac.netbird', service: 'dsh', machine: 'studio-mac', ip: '100.64.1.81' },
    { host: 'superset.studio-mac.netbird', service: 'superset', machine: 'studio-mac', ip: '100.64.1.81' },
    { host: 'dsh.desk-node.netbird', service: 'dsh', machine: 'desk-node', ip: '100.64.0.74' },
  ];
  const rows = markLocalEntries(fleet, ['100.64.1.81', '192.168.111.32']);
  assert.deepEqual(rows.map((row) => row.host), [
    'dsh.studio-mac.netbird',
    'superset.studio-mac.netbird',
    'dsh.desk-node.netbird',
  ]);
  assert.deepEqual(rows.map((row) => row.local), [true, true, false]);
  assert.deepEqual(rows.map((row) => row.service), ['dsh', 'superset', 'dsh']);
});

test('an address that is not this machine marks nothing, and malformed input yields no rows', () => {
  assert.deepEqual(markLocalEntries([{ host: 'dsh.desk-node.netbird', ip: '100.64.0.74' }], ['100.64.1.81']), [
    { host: 'dsh.desk-node.netbird', ip: '100.64.0.74', local: false },
  ]);
  assert.deepEqual(markLocalEntries(null, null), []);
  assert.deepEqual(markLocalEntries([{ host: '' }, null, { ip: '100.64.0.1' }], ['100.64.0.1']), []);
  // A prefixed address still matches, the way the peer table reports it.
  assert.equal(markLocalEntries([{ host: 'dsh.a.netbird', ip: '100.64.0.5' }], ['100.64.0.5/16'])[0].local, true);
});
