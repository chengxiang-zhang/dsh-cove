import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  SNAPSHOT_HEARTBEAT_HIDDEN_MS,
  SNAPSHOT_HEARTBEAT_MS,
  VIEW_PRUNE_GRACE_MS,
  shouldClearProxy,
  shouldReadSnapshotOnHeartbeat,
  snapshotHeartbeatMs,
  viewsToPrune,
} from '../src/snapshot-freshness.mjs';

// The machine list is the other half of "never show a frozen screen": the workspace page
// can be current while the list around it still claims what it read at launch.

test('a reading older than the heartbeat is re-read, a fresh one is not', () => {
  const now = 10_000_000;
  assert.equal(shouldReadSnapshotOnHeartbeat({ lastReadAt: now - SNAPSHOT_HEARTBEAT_MS, now }), true);
  assert.equal(shouldReadSnapshotOnHeartbeat({ lastReadAt: now - 1_000, now }), false);
});

test('a read already in flight is not doubled', () => {
  const now = 10_000_000;
  assert.equal(
    shouldReadSnapshotOnHeartbeat({ lastReadAt: now - SNAPSHOT_HEARTBEAT_MS * 2, now, inFlight: true }),
    false,
    'overlapping probes would double the traffic to every machine',
  );
});

test('an authoritative scripted reading is never overwritten by a real one', () => {
  const now = 10_000_000;
  assert.equal(
    shouldReadSnapshotOnHeartbeat({ lastReadAt: now - SNAPSHOT_HEARTBEAT_MS * 2, now, paused: true }),
    false,
  );
});

test('a list that was never read does not trigger the heartbeat', () => {
  // Launch has its own read; the heartbeat only ages a reading that exists.
  assert.equal(shouldReadSnapshotOnHeartbeat({ lastReadAt: 0, now: 10_000_000 }), false);
  assert.equal(shouldReadSnapshotOnHeartbeat({ lastReadAt: Number.NaN, now: 10_000_000 }), false);
});

test('a machine missing for the first time keeps its page', () => {
  // The list only holds machines that answered a probe, so one miss is usually a timeout.
  assert.deepEqual(
    viewsToPrune({ known: ['a'], open: ['a', 'b'], missingSince: {}, now: 10_000_000 }),
    [],
    'a page must not be destroyed over one missed probe',
  );
});

test('a machine missing past the grace window loses its page', () => {
  const now = 10_000_000;
  assert.deepEqual(
    viewsToPrune({ known: ['a'], open: ['a', 'gone'], missingSince: { gone: now - VIEW_PRUNE_GRACE_MS }, now }),
    ['gone'],
  );
  assert.deepEqual(
    viewsToPrune({ known: ['a'], open: ['a', 'gone'], missingSince: { gone: now - 1_000 }, now }),
    [],
  );
});

test('machines still in the list are never pruned, however long they were missing', () => {
  const now = 10_000_000;
  assert.deepEqual(
    viewsToPrune({
      known: ['a', 'b'],
      open: ['a', 'b'],
      missingSince: { a: now - VIEW_PRUNE_GRACE_MS * 10, b: now - VIEW_PRUNE_GRACE_MS * 10 },
      now,
    }),
    [],
  );
});

test('the proxy is cleared only when the engine that owned it is gone', () => {
  assert.equal(shouldClearProxy({ applied: 'http://127.0.0.1:19001', next: '' }), true);
  assert.equal(shouldClearProxy({ applied: '', next: '' }), false, 'nothing to clear');
  assert.equal(
    shouldClearProxy({ applied: 'http://127.0.0.1:19001', next: 'http://127.0.0.1:19002' }),
    false,
    'a changed proxy is replaced by applyAgentProxy, not cleared',
  );
});

// The policy only matters if the shell asks it; the main process cannot be imported by a
// unit test, so its wiring is pinned here. Each assertion is one call site whose removal
// puts the stale screen back.
test('the shell re-reads the list and replaces its derived state', () => {
  const source = readFileSync(fileURLToPath(new URL('../shell/main.mjs', import.meta.url)), 'utf8');
  assert.match(source, /from '\.\.\/src\/snapshot-freshness\.mjs'/, 'the shell must use the policy');
  assert.match(source, /lastPublishedAt = Date\.now\(\)/, 'a published reading is what the heartbeat ages');
  assert.match(source, /shouldReadSnapshotOnHeartbeat\(/, 'the heartbeat must use the policy');
  assert.match(source, /snapshotHeartbeatMs\(/, 'a hidden window must not probe at the watched rate');
  assert.match(source, /setTimeout\(heartbeatTick/, 'the list must be re-read on a timer, not only on a push');
  assert.match(source, /await currentSnapshot\(\)/, 'the heartbeat must actually read the machine list');
  assert.match(source, /viewsToPrune\(/, 'a vanished machine must not keep its page forever');
  assert.match(
    source,
    /shouldClearProxy\(/,
    'a proxy whose engine is gone must be cleared, or every request goes into a dead port',
  );
  assert.match(
    source,
    /snapshotRead = read\.finally/,
    'concurrent reads must share one probe instead of multiplying the traffic',
  );
  assert.match(
    source,
    /shouldRetryEndpointDiscovery\(/,
    'a launch-time miss on the channel document must be retried while nothing is dialable',
  );
  assert.match(
    source,
    /onExit:[\s\S]{0,200}recoverEngine/,
    'an engine that exits on its own must be answered with a restart, not a stale "connected"',
  );
  assert.match(
    source,
    /syncWindowChrome\(snapshot\)/,
    'the window title and tray tooltip must follow the reading, not the moment they were written',
  );
});

test('the heartbeat tightens when the window is watched and relaxes when it is hidden', () => {
  assert.equal(snapshotHeartbeatMs({ visible: true }), SNAPSHOT_HEARTBEAT_MS);
  assert.equal(snapshotHeartbeatMs({ visible: false }), SNAPSHOT_HEARTBEAT_HIDDEN_MS);
  assert.ok(
    SNAPSHOT_HEARTBEAT_HIDDEN_MS > SNAPSHOT_HEARTBEAT_MS,
    'a hidden window is the case that should cost less',
  );
});
