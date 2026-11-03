import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MACHINE_STATUS, machineCounts, machineRow, machineRows, machineStatusOf } from '../src/machine-list.mjs';

const ENTRY = {
  host: 'dsh.peer-a.netbird',
  machine: 'peer-a',
  ip: '100.64.1.10',
  zone: 'netbird',
  url: 'http://dsh.peer-a.netbird/',
  urls: ['https://dsh.peer-a.netbird/', 'http://dsh.peer-a.netbird/'],
};

test('the registry decides membership: a row exists with no probe at all', () => {
  const rows = machineRows([ENTRY], new Map());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].host, ENTRY.host);
  assert.equal(rows[0].status, MACHINE_STATUS.offline);
  assert.equal(rows[0].reachable, false);
  // The row keeps the registry URL, so it stays openable when the machine answers again.
  assert.equal(rows[0].url, ENTRY.url);
});

test('a service that answered is listed, whatever it declares about its authority', () => {
  // What a deployment declares is its own business: the row is this machine's service
  // and it answered, so it is usable. Neither the posture nor the declared bit is a
  // verdict shown on the card.
  for (const probe of [
    { reachable: true, posture: true, declared: false, statusCode: 200, reason: 'no declared authority' },
    { reachable: true, posture: false, declared: false, statusCode: 200 },
    { reachable: true, posture: true, declared: true, statusCode: 200 },
  ]) {
    const [row] = machineRows([ENTRY], new Map([[ENTRY.host, probe]]));
    assert.equal(row.status, MACHINE_STATUS.ready);
    assert.equal(row.reachable, true);
  }
});

test('a declared machine is ready and carries the probed entry', () => {
  const probes = new Map([[
    ENTRY.host,
    { reachable: true, posture: true, declared: true, statusCode: 200, url: 'https://dsh.peer-a.netbird/', unread: 3, unreadFailed: 1, latest: 7 },
  ]]);
  const [row] = machineRows([ENTRY], probes);
  assert.equal(row.status, MACHINE_STATUS.ready);
  assert.equal(row.declared, true);
  assert.equal(row.url, 'https://dsh.peer-a.netbird/');
  assert.equal(row.unread, 3);
  assert.equal(row.unreadFailed, 1);
  assert.equal(row.latest, 7);
});

test('a row of this machine carries no verdict instead of a false timeout', () => {
  // The engine cannot dial its own overlay address, so a local row must not be read as
  // "unreachable" when the only reason is that the probe could not try.
  const local = { ...ENTRY, local: true };
  const [row] = machineRows([local], new Map());
  assert.equal(row.status, MACHINE_STATUS.self);
  assert.equal(row.reachable, false);
});

test('a failing probe reads as offline and keeps the reason', () => {
  const probes = new Map([[ENTRY.host, { reachable: false, declared: false, reason: 'timed out' }]]);
  const [row] = machineRows([ENTRY], probes);
  assert.equal(row.status, MACHINE_STATUS.offline);
  assert.equal(row.reason, 'timed out');
  assert.equal(row.unread, 0);
});

test('status is derived from the probe only, and missing probes never throw', () => {
  assert.equal(machineStatusOf(undefined), MACHINE_STATUS.offline);
  assert.equal(machineStatusOf({ reachable: false }), MACHINE_STATUS.offline);
  assert.equal(machineStatusOf({ reachable: true }), MACHINE_STATUS.ready);
  assert.equal(machineStatusOf({ reachable: false }), MACHINE_STATUS.offline);
  const row = machineRow(ENTRY, null);
  assert.equal(row.status, MACHINE_STATUS.offline);
  // Nothing reshaped in the probe can corrupt the registry facts.
  assert.equal(row.host, ENTRY.host);
  assert.equal(row.ip, ENTRY.ip);
});

test('entries without a usable host are skipped, rest keep their order', () => {
  const rows = machineRows([null, { host: '' }, ENTRY, { host: 'dsh.peer-b.netbird', machine: 'peer-b' }], new Map());
  assert.deepEqual(rows.map((row) => row.host), ['dsh.peer-a.netbird', 'dsh.peer-b.netbird']);
});

test('counts say how the rows came out', () => {
  const counts = machineCounts([
    { status: MACHINE_STATUS.ready },
    { status: MACHINE_STATUS.ready },
    { status: MACHINE_STATUS.offline },
  ]);
  assert.deepEqual(counts, { ready: 2, offline: 1, total: 3 });
  assert.deepEqual(machineCounts([]), { ready: 0, offline: 0, total: 0 });
});
