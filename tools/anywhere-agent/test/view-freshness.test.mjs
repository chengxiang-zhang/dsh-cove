import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  WAKE_STALE_AFTER_MS,
  shouldReloadOnRefresh,
  shouldReloadOnWake,
  workspacePageAction,
} from '../src/view-freshness.mjs';

const moduleSource = readFileSync(fileURLToPath(new URL('../src/view-freshness.mjs', import.meta.url)), 'utf8');
const shellSource = readFileSync(fileURLToPath(new URL('../shell/main.mjs', import.meta.url)), 'utf8');

// The decision, as the shell asks it. Each case is named after the situation it
// protects, because a wrong answer here is a user losing their place in a conversation.

test('a page that already exists is reused, however long it was off screen', () => {
  assert.equal(workspacePageAction({ hasPage: true }), 'reuse');
  assert.equal(
    workspacePageAction({ hasPage: true, fresh: false }),
    'reuse',
    'switching tabs is a visibility change, not a navigation',
  );
});

test('the decision has no notion of elapsed time', () => {
  // The old timer reloaded a page hidden for five minutes and destroyed one hidden for
  // ten, guessing at a dead update socket. Both were removed: a hidden page keeps its
  // socket, and the DSH client reconnects one that dies.
  assert.equal(
    workspacePageAction({ hasPage: true, hiddenSince: 1, now: 9_999_999 }),
    'reuse',
    'an unexpected time input must not turn into a reload',
  );
  assert.doesNotMatch(
    moduleSource,
    /HIDDEN_STALE_AFTER_MS|hiddenSince/,
    'no hidden-duration branch may remain in the decision module',
  );
});

test('a view with no page yet is loaded', () => {
  assert.equal(workspacePageAction({ hasPage: false }), 'load');
  assert.equal(workspacePageAction({ hasPage: false, fresh: true }), 'load');
});

test('the new-session entry loads the front door, not a reuse of wherever the page was', () => {
  // The distinction matters: a reload keeps the page's route, while this entry must land
  // on the screen a conversation starts on.
  assert.equal(workspacePageAction({ hasPage: true, fresh: true }), 'load');
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
  assert.match(
    shellSource,
    /from '\.\.\/src\/view-freshness\.mjs'/,
    'the shell must use the shared policy rather than inline timers',
  );
  assert.match(shellSource, /workspacePageAction\(\{/, 'opening a machine must decide about its page');
  assert.doesNotMatch(
    shellSource,
    /hiddenSince/,
    'tab residency must not depend on how long a page was off screen',
  );
  assert.match(shellSource, /shouldReloadOnWake\(/, 'waking from sleep must decide about its page');
  assert.match(
    shellSource,
    /powerMonitor\.on\('resume'/,
    'a resume handler is the only thing that notices a page died while the machine slept',
  );
  const refreshPaths = shellSource.match(/reloadActiveWorkspace\(\)/g) ?? [];
  assert.ok(
    refreshPaths.length >= 3,
    `refresh must reload the page from the menu, the tray and the window; found ${refreshPaths.length} call sites`,
  );
});

test('nothing destroys or reloads a page because of elapsed time', () => {
  assert.doesNotMatch(
    shellSource,
    /IDLE_DISCARD_MS|reclaimIdleViews|startIdleReclaim/,
    'no idle reclaim timer: a hidden tab keeps its page until the tab or the machine goes',
  );
  assert.doesNotMatch(
    shellSource,
    /workspaceHiddenSince/,
    'the shell must not record when a page went off screen',
  );
});

test('switching to a tab never navigates it', () => {
  const start = shellSource.indexOf('async function activateTab(');
  assert.ok(start !== -1, 'activateTab must exist');
  const end = shellSource.indexOf('\n}\n', start);
  assert.ok(end !== -1, 'activateTab must have a body');
  const body = shellSource.slice(start, end);
  assert.doesNotMatch(body, /reload|loadURL/, 'a tab switch shows the resident page; it does not load one');
});
