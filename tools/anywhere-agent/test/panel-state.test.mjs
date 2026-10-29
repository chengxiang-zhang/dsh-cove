import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FLEET_STATES,
  LOCAL_STATES,
  UI_STATES,
  localEntry,
  localEntryFromAuthority,
  localRowsFrom,
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
    machine: 'studio-mac',
    ip: '',
    url: 'http://127.0.0.1:3080/',
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

test('the fleet row that addresses this machine is this machine, whatever it is called', () => {
  // One physical machine, two enrollments: the fleet knows it as `studio-mac` (the address the
  // OS holds) and this app enrolled with a collision suffix. The record that points at one
  // of the machine's addresses is this machine - no name comparison, no second row.
  const fleet = [
    { host: 'dsh.studio-mac.netbird', machine: 'studio-mac', ip: '100.64.1.81' },
    { host: 'dsh.workstation-189-193.netbird', machine: 'workstation-189-193', ip: '100.64.1.93' },
    { host: 'dsh.desk-node.netbird', machine: 'desk-node', ip: '100.64.0.74' },
  ];
  const { local, fleet: others } = localRowsFrom(
    fleet,
    ['100.64.1.81', '100.64.1.93', '192.168.111.32'],
    'http://127.0.0.1:3080/',
  );
  assert.ok(local, 'a record pointing at an address of this machine is this machine');
  assert.equal(local.host, 'dsh.studio-mac.netbird');
  assert.equal(local.machine, 'studio-mac', 'the row is labelled by the name the fleet reaches it by');
  assert.equal(local.local, true);
  assert.equal(local.url, 'http://127.0.0.1:3080/', 'this copy is the one in front of the user');
  assert.deepEqual(others.map((row) => row.host), ['dsh.desk-node.netbird'], 'this machine is not a second machine');
  assert.deepEqual(mergeEntries(local, others).map((row) => row.host), [
    'dsh.studio-mac.netbird',
    'dsh.desk-node.netbird',
  ]);
});

test('several records that address this machine are still one machine', () => {
  // Every enrollment of this machine publishes its own record; all of them are this machine.
  const fleet = [
    { host: 'dsh.b-enrollment.netbird', machine: 'b-enrollment', ip: '100.64.0.5' },
    { host: 'dsh.a-enrollment.netbird', machine: 'a-enrollment', ip: '100.64.0.6' },
    { host: 'dsh.desk-node.netbird', machine: 'desk-node', ip: '100.64.0.74' },
  ];
  const { local, fleet: others } = localRowsFrom(fleet, ['100.64.0.5', '100.64.0.6'], '');
  assert.equal(local.host, 'dsh.a-enrollment.netbird', 'the choice is stable across refreshes');
  assert.deepEqual(others.map((row) => row.host), ['dsh.desk-node.netbird'], 'a second enrollment is never a second machine');
});

test('with no record addressing this machine, no row claims to be it', () => {
  const { local, fleet: others } = localRowsFrom([{ host: 'dsh.desk-node.netbird', ip: '100.64.0.74' }], ['100.64.1.81'], '');
  assert.equal(local, null, 'identity is a fact about addresses, not a guess');
  assert.equal(others.length, 1);
  // The row builders survive anything a wire can deliver.
  assert.equal(localEntryFromAuthority('', ''), null);
  assert.equal(localEntryFromAuthority(undefined, ''), null);
  assert.equal(localEntryFromAuthority('dsh.studio-mac.netbird', '').machine, 'studio-mac');
  assert.equal(localEntryFromAuthority('studio-mac', '').machine, '');
  assert.deepEqual(localRowsFrom(null, null, ''), { local: null, fleet: [] });
});
