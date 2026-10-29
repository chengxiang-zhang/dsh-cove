import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  HIDDEN_STALE_AFTER_MS,
  WAKE_STALE_AFTER_MS,
  shouldReloadOnRefresh,
  shouldReloadOnWake,
  workspacePageAction,
} from '../src/view-freshness.mjs';

// The decision, as the shell asks it. Each case is named after the situation it
// protects, because a wrong answer here is a user looking at a frozen page.

test('a page that was just on screen is reused, keeping an unsent draft', () => {
  const now = 1_000_000;
  assert.equal(
    workspacePageAction({ hasPage: true, hiddenSince: now - 1_000, now }),
    'reuse',
    'a moment off screen must not throw away what the user typed',
  );
  assert.equal(
    workspacePageAction({ hasPage: true, hiddenSince: null, now }),
    'reuse',
    'the page on screen has been watched the whole time',
  );
});

test('a page hidden long enough for its socket to die is reloaded', () => {
  const now = 1_000_000;
  assert.equal(
    workspacePageAction({ hasPage: true, hiddenSince: now - HIDDEN_STALE_AFTER_MS, now }),
    'reload',
    'the boundary is inclusive: at the reuse window the page is already suspect',
  );
  assert.equal(
    workspacePageAction({ hasPage: true, hiddenSince: now - HIDDEN_STALE_AFTER_MS * 4, now }),
    'reload',
  );
});

test('a view with no page yet is loaded', () => {
  assert.equal(workspacePageAction({ hasPage: false, hiddenSince: null, now: 5 }), 'load');
  assert.equal(workspacePageAction({ hasPage: false, fresh: true, hiddenSince: 0, now: 5 }), 'load');
});

test('the new-session entry loads the front door, not a reload of wherever the page was', () => {
  // The distinction matters: a reload keeps the page's route, while this entry must land
  // on the screen a conversation starts on.
  assert.equal(
    workspacePageAction({ hasPage: true, fresh: true, hiddenSince: 1_000_000 - 1, now: 1_000_000 }),
    'load',
  );
});

test('a machine that slept reloads the page on screen, a brief sleep does not', () => {
  assert.equal(shouldReloadOnWake({ hasPage: true, suspendedMs: WAKE_STALE_AFTER_MS }), true);
  assert.equal(shouldReloadOnWake({ hasPage: true, suspendedMs: WAKE_STALE_AFTER_MS - 1 }), false);
  assert.equal(shouldReloadOnWake({ hasPage: false, suspendedMs: 3_600_000 }), false);
  assert.equal(
    shouldReloadOnWake({ hasPage: true, suspendedMs: Number.NaN }),
    false,
    'an unknown suspend duration is not evidence of a dead page',
  );
});

test('an explicit refresh reloads a loaded page and does nothing without one', () => {
  assert.equal(shouldReloadOnRefresh({ hasPage: true }), true);
  assert.equal(shouldReloadOnRefresh({ hasPage: false }), false);
});

// The policy only matters if the shell actually asks it. Text-level gates are how this
// package pins behaviour that lives in the Electron main process, which no unit test can
// import (it needs a running app). Each assertion below is one call site that, if dropped,
// puts the frozen page back.
test('the shell wires the policy into every path that can leave a page frozen', () => {
  const source = readFileSync(fileURLToPath(new URL('../shell/main.mjs', import.meta.url)), 'utf8');
  assert.match(
    source,
    /from '\.\.\/src\/view-freshness\.mjs'/,
    'the shell must use the shared policy rather than inline timers',
  );
  assert.match(source, /workspacePageAction\(\{/, 'opening a machine must decide about its page');
  assert.match(source, /shouldReloadOnWake\(/, 'waking from sleep must decide about its page');
  assert.match(
    source,
    /powerMonitor\.on\('resume'/,
    'a resume handler is the only thing that notices a page died while the machine slept',
  );
  const refreshPaths = source.match(/reloadActiveWorkspace\(\)/g) ?? [];
  assert.ok(
    refreshPaths.length >= 3,
    `refresh must reload the page from the menu, the tray and the window; found ${refreshPaths.length} call sites`,
  );
  assert.match(
    source,
    /workspaceHiddenSince\.set\(/,
    'a page that goes off screen must be recorded, or it is never considered stale',
  );
});
