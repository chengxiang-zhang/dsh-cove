import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { shouldReloadOnRefresh, workspacePageAction } from '../src/view-freshness.mjs';

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
  // The old timers reloaded a page hidden for five minutes, destroyed one hidden for ten,
  // and reloaded the page on screen after a long sleep. All three were removed: a hidden
  // page keeps its socket, Chromium reclaims background memory, and the DSH client
  // reconnects a socket that died with the suspend.
  assert.equal(
    workspacePageAction({ hasPage: true, hiddenSince: 1, now: 9_999_999 }),
    'reuse',
    'an unexpected time input must not turn into a reload',
  );
  assert.doesNotMatch(
    moduleSource,
    /HIDDEN_STALE_AFTER_MS|hiddenSince|WAKE_STALE|shouldReloadOnWake/,
    'no hidden-duration or wake branch may remain in the decision module',
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

test('an explicit refresh reloads a loaded page and does nothing without one', () => {
  assert.equal(shouldReloadOnRefresh({ hasPage: true }), true);
  assert.equal(shouldReloadOnRefresh({ hasPage: false }), false);
});

// The policy only matters if the shell actually asks it. Text-level gates are how this
// package pins behaviour that lives in the Electron main process, which no unit test can
// import (it needs a running app). Each assertion below is one call site that, if dropped,
// puts a page replacement back on a path the user did not ask for.
test('the shell wires the decision into opening a tab', () => {
  assert.match(
    shellSource,
    /from '\.\.\/src\/view-freshness\.mjs'/,
    'the shell must use the shared policy rather than inline logic',
  );
  assert.match(shellSource, /workspacePageAction\(\{/, 'opening a machine must decide about its page');
  assert.doesNotMatch(
    shellSource,
    /hiddenSince|IDLE_DISCARD_MS|reclaimIdleViews|startIdleReclaim/,
    'tab residency must not depend on how long a page was off screen',
  );
  assert.doesNotMatch(
    shellSource,
    /shouldReloadOnWake|WAKE_STALE_AFTER_MS/,
    'waking from sleep must not replace the page',
  );
});

test('exactly one reload path remains: the user asking for one', () => {
  const reloads = shellSource.match(/webContents\.reload\(\)/g) ?? [];
  assert.equal(
    reloads.length,
    1,
    `only reloadActiveWorkspace may replace a page, found ${reloads.length} reload call sites`,
  );
  // One command, and every entry point calls it: the control through the `refresh` IPC,
  // the page's own key layer, the chrome's key layer, the View menu and the tray.
  const commands = shellSource.match(/refreshScreen\(\)/g) ?? [];
  assert.ok(
    commands.length >= 4,
    `control, key layers, menu and tray must all use the one refresh command; found ${commands.length} references`,
  );
  const resumeAt = shellSource.indexOf("powerMonitor.on('resume'");
  assert.ok(resumeAt !== -1, 'a wake handler must still re-read the machine list');
  assert.doesNotMatch(
    shellSource.slice(resumeAt, resumeAt + 600),
    /reload\(/,
    'the wake handler may re-read the machine list, never replace the page',
  );
});

test('a refresh is only a reload: it never re-reads the machine list', () => {
  // The command is the browser's reload. Re-reading the machine list is the heartbeat's
  // job; coupling it here is what made the control wait seconds before the page moved,
  // and a rejected read meant the page never moved at all.
  const start = shellSource.indexOf('function refreshScreen()');
  assert.notEqual(start, -1, 'the shell must have one refresh command');
  const body = shellSource.slice(start, shellSource.indexOf('\n}\n', start));
  assert.match(body, /reloadActiveWorkspace\(\)/, 'the command must replace the page');
  assert.doesNotMatch(body, /refreshAgent\(|currentSnapshot\(/, 'the command must not read the machine list');
  assert.doesNotMatch(shellSource, /SCREEN_REFRESH_DEBOUNCE_MS/, 'no debounce may gate a reload');
});

test('the shortcut is caught where the key is delivered', () => {
  // The View menu carries ⌘R, but a page drawn in a native WebContentsView is its own first
  // responder: the key goes to that page and never reaches the menu item, which is why the
  // shortcut did nothing while reading a page. The key layer has to exist on the page.
  const layers = shellSource.match(/wireRefreshKey\(/g) ?? [];
  assert.ok(layers.length >= 3, `the machine page, the web page and the chrome must all answer ⌘R; found ${layers.length}`);
  assert.match(shellSource, /before-input-event/, 'the key is caught below the page renderer');
  const renderer = readFileSync(fileURLToPath(new URL('../shell/renderer/app.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(renderer, /refresh-key/, 'the native layers run the command directly; no forwarding step');
  assert.match(renderer, /api\.refresh\(\)/, 'the control asks the main process for the reload');
});

test('switching to a tab never navigates it', () => {
  const start = shellSource.indexOf('async function activateTab(');
  assert.ok(start !== -1, 'activateTab must exist');
  const end = shellSource.indexOf('\n}\n', start);
  assert.ok(end !== -1, 'activateTab must have a body');
  const body = shellSource.slice(start, end);
  assert.doesNotMatch(body, /reload|loadURL/, 'a tab switch shows the resident page; it does not load one');
});
