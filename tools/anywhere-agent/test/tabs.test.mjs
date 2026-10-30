import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activate,
  activeTab,
  close,
  createState,
  isServiceOpen,
  openHome,
  openService,
  openSettings,
  reorder,
  restore,
  retitle,
  serialize,
  serviceTabId,
} from '../src/tabs.mjs';

test('the home is created once and reopened, never duplicated', () => {
  const first = openHome(createState());
  assert.equal(first.created, true);
  assert.equal(first.state.tabs.length, 1);
  assert.equal(first.state.activeId, 'home');

  const second = openHome(first.state);
  assert.equal(second.created, false);
  assert.equal(second.state.tabs.length, 1);
});

test('a service opens one tab, and opening it again activates that tab', () => {
  const home = openHome(createState()).state;
  const a = openService(home, 'machine:peer-a', 'peer-a');
  assert.equal(a.created, true);
  assert.equal(a.id, serviceTabId('machine:peer-a'));
  assert.equal(a.state.tabs.length, 2);

  const b = openService(a.state, 'machine:peer-a');
  assert.equal(b.created, false);
  assert.equal(b.state.tabs.length, 2);
  assert.equal(b.state.activeId, a.id);
  assert.equal(isServiceOpen(a.state, 'machine:peer-a'), true);
});

test('activation ignores unknown ids instead of blanking the window', () => {
  const home = openHome(createState()).state;
  assert.equal(activate(home, 'nope'), home);
  const service = openService(home, 'machine:a').state;
  assert.equal(activate(service, 'nope').activeId, service.activeId);
});

test('closing a tab activates its right neighbour, else its left', () => {
  let state = openHome(createState()).state;
  const a = openService(state, 'machine:a').state;
  const b = openService(a, 'machine:b').state;
  const c = openService(b, 'machine:c').state;
  // tabs: home, a, b, c (c active)
  const closedB = close(c, 'svc:machine:b').state;
  assert.equal(closedB.tabs.length, 3);
  assert.equal(closedB.activeId, 'svc:machine:c', 'the active tab is untouched when another one closes');

  const closedActive = close(c, 'svc:machine:c').state;
  assert.equal(closedActive.activeId, 'svc:machine:b', 'right neighbour is gone, so the left one');

  const onHome = activate(c, 'home');
  const closedFirst = close(onHome, 'home').state;
  assert.equal(closedFirst.activeId, 'svc:machine:a', 'closing the active home falls to the next tab');
});

test('closing the last tab brings the home back instead of an empty window', () => {
  const state = openService(createState(), 'machine:a').state;
  assert.equal(state.tabs.length, 1);
  const { state: after, closed } = close(state, 'svc:machine:a');
  assert.equal(closed, true);
  assert.equal(after.tabs.length, 1);
  assert.equal(after.activeId, 'home');
  assert.equal(after.tabs[0].kind, 'home');
});

test('closing the home from a single-tab window also leaves a home', () => {
  const home = openHome(createState()).state;
  const { state: after } = close(home, 'home');
  assert.equal(after.tabs.length, 1);
  assert.equal(after.activeId, 'home');
});

test('the settings page is a tab and is also unique', () => {
  let state = openHome(createState()).state;
  const one = openSettings(state);
  assert.equal(one.created, true);
  const two = openSettings(one.state);
  assert.equal(two.created, false);
  assert.equal(two.state.tabs.length, 2);
});

test('reorder moves a tab and ignores out-of-range moves', () => {
  const state = openService(openService(openHome(createState()).state, 'machine:a').state, 'machine:b').state;
  const moved = reorder(state, 2, 0);
  assert.deepEqual(moved.tabs.map((tab) => tab.id), ['svc:machine:b', 'home', 'svc:machine:a']);
  assert.equal(reorder(state, 0, 9), state);
  assert.equal(reorder(state, -1, 1), state);
});

test('retitle only touches the tab it names', () => {
  const state = openService(openHome(createState()).state, 'machine:a').state;
  const renamed = retitle(state, 'svc:machine:a', '新标题');
  assert.equal(activeTab(renamed).title, '新标题');
  assert.equal(retitle(state, 'nope', 'x'), state);
  assert.equal(retitle(renamed, 'svc:machine:a', '新标题'), renamed, 'same title is not a change');
});

test('serialize/restore keeps order, drops unknown services, and never yields an empty state', () => {
  const state = openService(openService(openHome(createState()).state, 'machine:a').state, 'web:gitlab').state;
  const items = serialize(state);
  assert.deepEqual(items.map((item) => item.kind), ['home', 'service', 'service']);

  const back = restore(items, { known: (id) => id !== 'web:gitlab', activeId: 'svc:web:gitlab' });
  assert.deepEqual(back.tabs.map((tab) => tab.id), ['home', 'svc:machine:a']);
  assert.equal(back.activeId, 'home', 'the active tab was dropped, so the first surviving tab wins');

  const empty = restore([], {});
  assert.equal(empty.tabs.length, 1);
  assert.equal(empty.activeId, 'home');
});

test('restore tolerates junk entries', () => {
  const state = restore([null, 42, { kind: 'service' }, { kind: 'service', serviceId: '' }, { kind: 'home' }, { kind: 'home' }]);
  assert.deepEqual(state.tabs.map((tab) => tab.id), ['home']);
});

test('restoring keeps the previously active tab when it survived', () => {
  const items = [
    { kind: 'home', serviceId: '' },
    { kind: 'service', serviceId: 'machine:a' },
    { kind: 'service', serviceId: 'machine:b' },
  ];
  const state = restore(items, { known: () => true, activeId: 'svc:machine:b' });
  assert.equal(state.activeId, 'svc:machine:b');
});
