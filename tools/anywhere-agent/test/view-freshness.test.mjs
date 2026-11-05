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
  // One command, and the native layers only ask for it: a keystroke or a menu item that
  // ran the sequence itself would also bypass the lock the control carries.
  const asks = shellSource.match(/requestRefresh\(\)/g) ?? [];
  assert.ok(
    asks.length >= 4,
    `the key layers, the View menu and the tray must ask the window for a refresh; found ${asks.length} references`,
  );
  assert.match(
    shellSource,
    /mainWindow\.webContents\.send\('refresh-key'\)/,
    'the native layers hand the request to the window, where the lock lives',
  );
  const resumeAt = shellSource.indexOf("powerMonitor.on('resume'");
  assert.ok(resumeAt !== -1, 'a wake handler must still re-read the machine list');
  assert.doesNotMatch(
    shellSource.slice(resumeAt, resumeAt + 600),
    /reload\(/,
    'the wake handler may re-read the machine list, never replace the page',
  );
});

test('the page is replaced before the reading that can take seconds', () => {
  // A refresh is pressed because the screen already looks stuck, while re-reading probes
  // the host, the kernel and every machine in the list - seconds on a network with one
  // machine that does not answer, and a failure is possible. Reloading after that read is
  // what made the control look dead; a rejected read also meant the reload never ran.
  const start = shellSource.indexOf('async function refreshScreen()');
  assert.notEqual(start, -1, 'the shell must have one refresh command');
  const body = shellSource.slice(start, shellSource.indexOf('\n}\n', start));
  const reloadAt = body.indexOf('reloadActiveWorkspace()');
  const readAt = body.indexOf('refreshAgent()');
  assert.ok(reloadAt !== -1, 'the command must replace the page');
  assert.ok(readAt !== -1, 'the command must still bring the reading up to date');
  assert.ok(reloadAt < readAt, 'the page must be replaced before the read that can take seconds');
  assert.match(body, /catch/, 'a failed read must report itself instead of cancelling the replacement');
});

test('the shortcut is caught where the key is delivered, and one press reloads once', () => {
  // The View menu carries ⌘R, but a page drawn in a native WebContentsView is its own first
  // responder: the key goes to that page and never reaches the menu item. The key layer
  // has to exist on the page itself.
  const layers = shellSource.match(/wireRefreshKey\(/g) ?? [];
  assert.ok(layers.length >= 3, `the machine page, the web page and the chrome must all answer ⌘R; found ${layers.length}`);
  assert.match(shellSource, /before-input-event/, 'the key is caught below the page renderer');
  assert.match(
    shellSource,
    /SCREEN_REFRESH_DEBOUNCE_MS/,
    'two layers may both answer one keystroke, so the command must collapse the duplicate',
  );
  // The window is where the lock lives, so the forwarded request must respect it: a menu
  // item or a keystroke must not re-run the preparation a disabled control refuses.
  const renderer = readFileSync(fileURLToPath(new URL('../shell/renderer/app.js', import.meta.url)), 'utf8');
  const handlerAt = renderer.indexOf("onMenu('refresh-key'");
  assert.notEqual(handlerAt, -1, 'the renderer must answer the request the native layers forward');
  assert.match(
    renderer.slice(handlerAt, handlerAt + 260),
    /el\.refresh\.disabled/,
    'the forwarded request must honour the control lock',
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
