import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Loaded the way the browser loads it: a classic script with no module system in
// scope. `require` cannot work here - the package sets `"type": "module"`, so a
// `.js` file is ESM to Node, while the same file is a classic script to Chromium.
const source = readFileSync(fileURLToPath(new URL('../shell/renderer/view.js', import.meta.url)), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const { viewModel, groupMachines, resolveSelection, kernelFact, statusOf, diagnosticsOf, accountOf, PROVISIONING_COPY, REFRESH_LOCKED } = sandbox.AWView;

test('refresh stays available while a connection is being made', () => {
  // Refresh means "read the list again"; it is the one thing a person can press when a
  // connection looks stuck. Only preparing this machine runs a sequence that a second
  // press would duplicate, so only that state may lock the button.
  assert.deepEqual(plain(REFRESH_LOCKED), ['provisioning']);
  assert.equal(REFRESH_LOCKED.includes('connecting'), false);
});

// Values built inside the vm realm have that realm's prototypes, and a strict deep
// comparison rejects them for that alone. Normalising keeps the assertion about the
// content, which is the thing under test.
const plain = (value) => JSON.parse(JSON.stringify(value));

const ENGINE = { protocol: 1, helper: '0.1.1', netbird: 'v0.78.1' };
const SELF = { machine: 'studio-mac', ip: '100.64.1.81', interfaceType: 'Userspace' };
const KERNEL = { installed: true, version: '0.2.0-rc.2', reachable: true, service: { label: 'org.dsh.web', loaded: false } };
const LOCAL = { state: 'ready', detail: '', machine: 'studio-mac', host: 'dsh.studio-mac.netbird', url: 'http://127.0.0.1:3080/' };
const entry = (machine, ip, statusCode) => ({
  host: `dsh.${machine}.netbird`,
  machine,
  ip,
  url: `http://dsh.${machine}.netbird/`,
  statusCode,
});

/** The ordinary single-machine user: this machine only, no account, no network. */
const SOLO = {
  state: 'local',
  local: LOCAL,
  fleet: { state: 'off', detail: '' },
  self: null,
  kernel: KERNEL,
  registered: 1,
  entries: [{ ...entry('studio-mac', '127.0.0.1'), url: 'http://127.0.0.1:3080/', local: true }],
};

/** Signed in, with the fleet's own reading of this machine and two others. */
const READY = {
  state: 'ready',
  local: LOCAL,
  fleet: { state: 'ready', detail: '3 machines reachable by registration' },
  engine: ENGINE,
  // The fleet's canonical authority for this machine, which is what the grouping
  // compares - the engine's own name for it can differ.
  self: { ...SELF, host: 'dsh.studio-mac.netbird' },
  kernel: KERNEL,
  registered: 3,
  entries: [
    { ...entry('studio-mac', '100.64.1.81'), local: true },
    entry('tower-lab', '100.64.1.74'),
    entry('imac-office', '100.64.1.23', 302),
  ],
};

test('every state has a label, a tone and a panel with a way out', () => {
  const expected = {
    provisioning: { label: '正在准备', tone: 'busy', actions: 0 },
    local: { label: '本机可用', tone: 'good', actions: 0 },
    connecting: { label: '正在接入', tone: 'busy', actions: 1 },
    'login-required': { label: '等待登录', tone: 'attention', actions: 2 },
    ready: { label: '已连接', tone: 'good', actions: 0 },
    empty: { label: '没有其他机器', tone: 'idle', actions: 1 },
    error: { label: '连不上', tone: 'bad', actions: 2 },
  };
  for (const [state, spec] of Object.entries(expected)) {
    const model = viewModel({ state });
    assert.equal(model.status.label, spec.label, state);
    assert.equal(model.status.tone, spec.tone, state);
    assert.equal(model.detail.state.actions.length, spec.actions, `${state} actions`);
    assert.ok(model.detail.state.title.length > 0, state);
    // A state explains itself unless it has nothing to add: "preparing" narrates work in
    // progress, and the two home screens ask a question their own button answers.
    if (!['provisioning', 'local', 'ready'].includes(state)) {
      assert.ok(model.detail.state.body.length > 0, `${state} explains itself`);
    }
  }
});

test('connecting offers the way back to this machine', () => {
  // This is the state with no end of its own: without an action the window simply sat
  // there while a dial ran out, and the account chip disabled itself.
  const model = viewModel({ state: 'connecting', local: LOCAL, fleet: { state: 'connecting' } });
  assert.deepEqual(plain(model.detail.state.actions), [{ id: 'fleet-off', label: '改用本机' }]);
  assert.match(model.detail.state.body, /正在联系服务器/);
  // The chip names what is happening rather than promising a search that is not running.
  assert.equal(model.account.line, '正在联系服务器');
  assert.deepEqual(plain(model.account.action), { id: 'fleet-off', label: '改用本机' });
});

test('an unknown state degrades to provisioning rather than throwing', () => {
  for (const snapshot of [undefined, {}, { state: 'nonsense' }, null]) {
    const model = viewModel(snapshot);
    assert.equal(model.state, 'provisioning');
    assert.equal(model.detail.kind, 'state');
    assert.equal(model.sidebar.groups.flatMap((group) => group.machines).length, 0);
  }
});

test('the client checking this machine says what it is doing', () => {
  const model = viewModel({
    state: 'provisioning',
    local: { ...LOCAL, state: 'checking', detail: '正在检查本机环境' },
  });
  assert.equal(model.detail.state.title, '正在检查本机环境');
  assert.equal(model.detail.state.actions.length, 0, 'nothing to press while it works');
});

test('a machine that is not set up is answered with a command, not an install', () => {
  const command = 'curl -fsSL https://channel.example/install.sh | sh';
  const local = {
    ...LOCAL,
    state: 'needs-install',
    detail: 'this machine has no Node 22 or newer this app can see',
    command,
  };
  const model = viewModel({ state: 'provisioning', local });

  assert.equal(model.detail.state.title, '本机还没装好');
  // The exact command is in the panel: the app hands it over instead of fetching a
  // runtime into itself.
  assert.match(model.detail.state.body, /install\.sh/);
  assert.deepEqual(plain(model.detail.state.actions), [
    'run-installer',
    'retry',
  ]);

  // No command configured: the button is not offered, because a button that cannot run
  // anything is worse than no button.
  const without = viewModel({
    state: 'provisioning',
    local: { ...LOCAL, state: 'needs-install', detail: 'no runtime' },
  });
  assert.deepEqual(plain(without.detail.state.actions), ['retry']);
});

test('using this machine needs no account at all', () => {
  const model = viewModel(SOLO);
  assert.equal(model.state, 'local');
  assert.equal(model.status.label, '本机可用');
  // The window lands on the home; asking for the machine is what opens it.
  assert.equal(model.detail.kind, 'state');
  assert.equal(model.detail.state.kind, 'home');
  const inside = viewModel(SOLO, { mode: 'workspace' });
  assert.equal(inside.detail.kind, 'workspace');
  assert.equal(inside.detail.machine.host, 'dsh.studio-mac.netbird');
  // The row is present, and it is this machine; the second section is where the
  // other machines will appear.
  assert.deepEqual(plain(model.sidebar.groups.map((group) => [group.id, group.machines.length])), [
    ['self', 1],
    ['fleet-off', 0],
  ]);
});

test('the home is a launch pad, and the rail names which view is up', () => {
  const home = viewModel(READY);
  assert.equal(home.rail.active, 'machines');
  assert.equal(home.rail.session.disabled, false);
  assert.equal(home.detail.kind, 'state');
  assert.equal(home.detail.state.kind, 'home');
  assert.equal(home.detail.state.title, '要打开哪台机器?');
  // The primary action names the machine it would open, so the button is not a guess.
  assert.deepEqual(plain(home.detail.state.actions), [
    { id: 'open-selected', label: '打开 studio-mac 的工作区', primary: true },
  ]);
  // The button names the machine, so the pane does not repeat the question or the answer.
  assert.equal(home.detail.state.body, '');

  const inside = viewModel(READY, { mode: 'workspace' });
  assert.equal(inside.rail.active, 'session');
  assert.equal(inside.detail.kind, 'workspace');

  // Nothing to open: the entry is disabled and the pane says why instead of offering a
  // button that would fail.
  const preparing = viewModel({ state: 'provisioning' });
  assert.equal(preparing.rail.session.disabled, true);
  assert.equal(preparing.detail.state.kind, 'state');
  const dry = viewModel({ state: 'ready', entries: [], self: SELF });
  assert.equal(dry.rail.session.disabled, true);
  assert.equal(dry.detail.state.kind, 'home');
  assert.deepEqual(plain(dry.detail.state.actions), []);

  // Diagnostics is a toggle, not a view: it reports its pressed state and never steals
  // the current-view mark.
  const open = viewModel(READY, { diagnostics: true });
  assert.equal(open.rail.diagnostics.pressed, true);
  assert.equal(open.rail.active, 'machines');
});

test('the list offers the way to the other machines instead of hiding it', () => {
  const model = viewModel(SOLO);
  const group = model.sidebar.groups.find((candidate) => candidate.id === 'fleet-off');
  assert.ok(group, 'the section exists before anyone signs in');
  assert.equal(group.title, '其他机器');
  assert.match(group.hint, /登录后/);
  assert.deepEqual(plain(group.action), { id: 'connect', label: '登录' });
});

test('the second section says which of the four situations the user is in', () => {
  // An absent section would read as "you own one computer", which the client cannot
  // know before anyone has signed in.
  const hints = {
    connecting: /正在联系服务器/,
    'login-required': /登录后/,
    empty: /还没有别的电脑/,
    error: /网络连接失败/,
    ready: /还没有别的电脑/,
  };
  for (const [fleetState, pattern] of Object.entries(hints)) {
    const model = viewModel({
      state: fleetState,
      local: LOCAL,
      fleet: { state: fleetState, detail: '' },
      entries: [{ ...entry('studio-mac', '127.0.0.1'), local: true }],
    });
    const group = model.sidebar.groups.find((candidate) => candidate.id === 'ours' || candidate.id === 'fleet-off');
    assert.ok(group, fleetState);
    assert.match(group.hint, pattern, fleetState);
  }
  // Only the sign-in state offers the action again in the section header: everywhere
  // else the pane already carries it, and two identical buttons are noise.
  const empty = viewModel({ state: 'empty', local: LOCAL, fleet: { state: 'empty' }, entries: [] });
  assert.equal(empty.sidebar.groups[0].action, undefined);
});

test('the list splits into this machine and the others, in that order', () => {
  const model = viewModel(READY);
  assert.deepEqual(
    plain(model.sidebar.groups.map((group) => [group.id, group.title, group.machines.length])),
    [
      ['self', '本机', 1],
      ['ours', '其他机器', 2],
    ],
  );
  assert.equal(model.sidebar.groups[0].machines[0].name, 'studio-mac');
});

test('selection is stable across a refresh and falls back to the first machine', () => {
  assert.equal(viewModel(READY, { selected: 'dsh.tower-lab.netbird' }).sidebar.selected, 'dsh.tower-lab.netbird');
  // A selection that is gone (the machine dropped out) falls back rather than
  // leaving the pane pointed at nothing.
  assert.equal(viewModel(READY, { selected: 'dsh.gone.netbird' }).sidebar.selected, 'dsh.studio-mac.netbird');
  assert.equal(viewModel({ state: 'empty' }, { selected: 'dsh.tower-lab.netbird' }).sidebar.selected, '');
});

test('search matches the fields a person would type and says when nothing matches', () => {
  assert.equal(viewModel(READY, { query: 'tower' }).sidebar.shown, 1);
  assert.equal(viewModel(READY, { query: '100.64.1.23' }).sidebar.shown, 1);
  assert.equal(viewModel(READY, { query: 'TOWER-LAB' }).sidebar.shown, 1, 'case does not matter');
  const none = viewModel(READY, { query: 'nothing-like-this' });
  assert.equal(none.sidebar.shown, 0);
  assert.equal(none.sidebar.groups[0].title, '没有匹配的机器');
});

test('a machine that needs a sign-in is marked, and the row carries its address', () => {
  const model = viewModel(READY);
  const wq = model.sidebar.groups.flatMap((group) => group.machines).find((machine) => machine.name === 'imac-office');
  assert.equal(wq.badge, '需登录');
  assert.equal(wq.needsLogin, true);
  assert.equal(wq.line, 'dsh.imac-office.netbird', 'the row names the machine, not its address');
  assert.equal(wq.address, '100.64.1.23');
});

test('a machine with finished work nobody has looked at carries the unread count', () => {
  const model = viewModel({
    ...READY,
    entries: [
      entry('studio-mac', '100.64.1.81'),
      { ...entry('tower-lab', '100.64.1.74'), unread: 2 },
      entry('imac-office', '100.64.1.23', 302),
    ],
  });
  const rows = model.sidebar.groups.flatMap((group) => group.machines);
  const tower = rows.find((machine) => machine.name === 'tower-lab');
  assert.equal(tower.unread, true);
  assert.equal(tower.unreadCount, 2, 'the badge carries the number, not just a colour');
  // A dot with no words is a defect: the count is part of what the row says, in the
  // accessible name and in the hover text.
  assert.match(tower.label, /2 项新结果/);
  assert.match(tower.title, /2 项新结果/);
  assert.equal(tower.badge, '', 'the unread mark is not the sign-in badge');

  // No count, a zero, or nonsense from the wire never lights it and never throws.
  const mac = rows.find((machine) => machine.name === 'studio-mac');
  assert.equal(mac.unread, false);
  assert.equal(mac.unreadCount, 0);
  assert.equal(mac.unreadLabel, '');
  assert.equal(/新结果/.test(mac.label), false);
  for (const value of [0, -3, 'many', null, undefined, {}, Number.NaN]) {
    const single = viewModel({ ...READY, entries: [{ ...entry('tower-lab', '2.2.2.2'), unread: value }] });
    const machine = single.sidebar.groups.flatMap((group) => group.machines)[0];
    assert.equal(machine.unread, false, `unread=${String(value)}`);
    assert.equal(machine.unreadCount, 0, `unread=${String(value)}`);
  }
});

test('a machine can need a sign-in and have unread work at the same time', () => {
  const model = viewModel({
    ...READY,
    entries: [
      entry('studio-mac', '100.64.1.81'),
      { ...entry('imac-office', '100.64.1.23', 302), unread: 1 },
    ],
  });
  const wq = model.sidebar.groups.flatMap((group) => group.machines).find((machine) => machine.name === 'imac-office');
  // Neither mark replaces the other: one says how to get in, the other says why to.
  assert.equal(wq.badge, '需登录');
  assert.equal(wq.needsLogin, true);
  assert.equal(wq.unread, true);
  assert.equal(wq.unreadCount, 1);
  assert.equal(wq.label, 'imac-office,dsh.imac-office.netbird,需登录,1 项新结果');
  assert.equal(wq.title, 'imac-office · dsh.imac-office.netbird · 100.64.1.23 · 1 项新结果');
});

test('the row says how loud to be: a failure is an alarm, finished work is a count', () => {
  const clean = viewModel({ ...READY, entries: [{ ...entry('tower-lab', '100.64.1.74'), unread: 2, unreadFailed: 0 }] });
  const ordinary = clean.sidebar.groups.flatMap((group) => group.machines).find((machine) => machine.name === 'tower-lab');
  assert.equal(ordinary.unreadTone, 'notice', 'nothing failed, so the row stays quiet');
  assert.equal(ordinary.unreadLabel, '2 项新结果');

  const broken = viewModel({ ...READY, entries: [{ ...entry('tower-lab', '100.64.1.74'), unread: 3, unreadFailed: 1 }] });
  const alarming = broken.sidebar.groups.flatMap((group) => group.machines).find((machine) => machine.name === 'tower-lab');
  assert.equal(alarming.unreadTone, 'danger', 'one of them failed, so the row carries the alarm');
  // The accessible name carries the same distinction as the colour, so nothing here is
  // information a person can only get by seeing it.
  assert.equal(alarming.unreadLabel, '3 项新结果（含出错）');
  assert.match(alarming.label, /3 项新结果（含出错）/);
});

test('the unread mark changes neither the machine count nor the status line', () => {
  const plainModel = viewModel(READY);
  const dotted = viewModel({ ...READY, entries: READY.entries.map((item) => ({ ...item, unread: 3 })) });
  assert.equal(dotted.status.label, plainModel.status.label);
  assert.equal(dotted.status.detail, '3 台可达');
  assert.equal(dotted.status.detail, plainModel.status.detail);
  assert.equal(dotted.sidebar.shown, plainModel.sidebar.shown);
  assert.equal(dotted.sidebar.registered, plainModel.sidebar.registered);
  assert.deepEqual(
    plain(dotted.sidebar.groups.map((group) => [group.id, group.machines.length])),
    plain(plainModel.sidebar.groups.map((group) => [group.id, group.machines.length])),
  );
});

test('the detail pane is a workspace only when there is one to show', () => {
  const ready = viewModel(READY, { mode: 'workspace' });
  assert.equal(ready.detail.kind, 'workspace');
  assert.equal(ready.detail.machine.host, 'dsh.studio-mac.netbird');
  // Ready but with nothing to show: the pane explains itself instead of going blank.
  const dry = viewModel({ state: 'ready', entries: [], self: SELF });
  assert.equal(dry.detail.kind, 'state');
  assert.equal(dry.notice.length > 0, true);
});

test('the sign-in is a button, and the hand-off link never reaches the screen', () => {
  const model = viewModel({
    state: 'login-required',
    engine: ENGINE,
    loginUrl: 'https://sso.example/oauth2/auth?audience=netbird-cli',
    local: LOCAL,
    fleet: { state: 'login-required', detail: '' },
    server: { url: 'https://netbird.corp.example:443', host: 'netbird.corp.example', source: 'bundled', isCustom: false },
  });
  assert.deepEqual(plain(model.detail.state.actions), ['login-open']);
  // One line, in the user's own terms: the machine they are on is unaffected.
  assert.match(model.detail.state.body, /本机不受影响/);
  assert.equal(model.detail.state.title, '登录');
  // The address is on the panel, because it is the fact that explains a failure and the
  // one the person can change.
  assert.match(model.detail.state.server, /netbird\.corp\.example/);
  assert.equal(model.server.source, 'bundled');
  // The URL is short-lived and re-minted on the click, so no part of the model may
  // carry it: a stale link on screen is indistinguishable from a broken app.
  assert.equal(JSON.stringify(model).includes('sso.example'), false);
  assert.equal(/https?:\/\//.test(JSON.stringify(model.detail)), false);
});

test('a press of 登录 is acknowledged, and cannot be repeated while it works', () => {
  // Measured: minting a hand-off can take long enough that a press looks ignored, and a
  // press that looks ignored gets repeated - which handed the browser the same link once
  // per press, opening several tabs for one intent.
  const snapshot = {
    state: 'login-required',
    local: LOCAL,
    fleet: { state: 'login-required' },
    server: { url: 'https://netbird.corp.example:443', host: 'netbird.corp.example', source: 'bundled' },
  };
  const idle = viewModel(snapshot);
  assert.equal(idle.detail.pending, false);
  assert.equal(idle.detail.state.note, '', 'nothing to report while nothing is happening');

  const busy = viewModel(snapshot, { pending: 'login' });
  assert.equal(busy.detail.pending, true, 'the button that started the work says so');
  assert.equal(busy.detail.state.note, '正在打开浏览器…');
  assert.equal(busy.detail.state.noteTone, '', 'working is not a failure');
  // The label still comes from the one table that owns the word: this is a fact, not a copy.
  assert.deepEqual(plain(busy.detail.state.actions), ['login-open']);

  const failed = viewModel(snapshot, { note: 'sign-in could not be renewed: no available port' });
  assert.match(failed.detail.state.note, /no available port/);
  assert.equal(failed.detail.state.noteTone, 'danger');
});

test('with no address at all, the field takes the place of the sign-in buttons', () => {
  // This is the shipped desktop's own state: nothing was ever told where the fleet is, so
  // there is no link to hand anyone. Offering "在浏览器中登录" here would be a button that
  // cannot work, so the address is what the panel asks for.
  const model = viewModel({
    state: 'login-required',
    local: LOCAL,
    fleet: { state: 'login-required', detail: '还没有服务器地址' },
    server: { url: '', host: '', source: 'none', isCustom: false },
  });
  assert.equal(model.detail.state.title, '填服务器地址');
  assert.deepEqual(plain(model.detail.state.actions), ['set-server', 'fleet-off']);
  assert.equal(model.detail.state.server, '服务器：还没有地址');
  assert.equal(model.server.hasUrl, false);
  // The chip leads to the same place the panel does.
  assert.deepEqual(plain(model.account.action), { id: 'set-server', label: '设置服务器' });
});

test('a server the user set themselves is marked, as the mobile client marks it', () => {
  const model = viewModel({
    state: 'login-required',
    local: LOCAL,
    server: { url: 'https://netbird.mine.example:443', host: 'netbird.mine.example', source: 'choice', isCustom: true },
  });
  assert.equal(model.detail.state.server, '服务器：netbird.mine.example（自建）');
  const diagnostics = diagnosticsOf({
    local: LOCAL,
    server: { url: 'https://netbird.mine.example:443', host: 'netbird.mine.example', source: 'choice', isCustom: true },
  });
  const row = diagnostics.find((entry) => entry.label === '服务器');
  assert.equal(row.value, 'netbird.mine.example（自建）（自己设置）');
});

test('the error panel quotes the engine rather than rewording it', () => {
  const model = viewModel({ state: 'error', detail: 'engine protocol 2 does not match the required 1' });
  assert.equal(model.detail.state.body, 'engine protocol 2 does not match the required 1');
  // The engine's sentence never says which server it was talking to, so the panel names it
  // and offers to change it - and a retry, because the answer may simply be late.
  assert.deepEqual(plain(model.detail.state.actions), ['retry', 'set-server']);
  // A failure to prepare this machine has no engine to quote, so the local reason is
  // what the user is shown.
  const localFailure = viewModel({ state: 'error', local: { ...LOCAL, state: 'error', detail: 'npm reported success but dsh is still not on PATH' } });
  assert.match(localFailure.detail.state.body, /still not on PATH/);
  // And it must not offer the server field: this machine's own host is what failed, so the
  // address has nothing to do with it.
  assert.equal(localFailure.detail.state.title, '本机服务起不来');
  assert.deepEqual(plain(localFailure.detail.state.actions), ['retry']);
  const withCommand = viewModel({
    state: 'error',
    local: { ...LOCAL, state: 'error', detail: 'no runtime', command: 'curl -fsSL https://channel.example/install.sh | sh' },
  });
  assert.deepEqual(plain(withCommand.detail.state.actions), ['run-installer', 'retry']);
});

test('the panels never explain the machinery', () => {
  // The words a user cannot act on: engines, maps, nodes, protocols, overlays. A panel
  // that uses them is describing our implementation, not their situation.
  const jargon = ['引擎', '映射', '节点', '协议', '覆盖网', 'netstack', 'peer', 'bridge'];
  for (const state of ['provisioning', 'local', 'connecting', 'login-required', 'empty', 'error', 'ready']) {
    const model = viewModel({ state, detail: 'engine protocol 2 does not match the required 1' });
    const text = `${model.detail.state.title} ${model.detail.state.body}`;
    for (const word of jargon) {
      assert.equal(text.includes(word), false, `${state} must not say ${word}`);
    }
  }
  // Brevity is part of it: a panel body is a sentence, not a paragraph.
  for (const state of ['login-required', 'empty', 'ready']) {
    assert.ok(viewModel({ state }).detail.state.body.length <= 60, `${state} stays short`);
  }
});

test('the brand introduces the product once and then stays out of the way', () => {
  const brand = { name: 'Anywhere Work', tagline: { zh: '在任何地方,接着干你的活。' } };
  // The one screen where the product has just met the user. Everywhere else the tagline was
  // a line above a decision the person had already come to make.
  assert.equal(viewModel({ state: 'provisioning' }, { brand }).welcome.tagline, '在任何地方,接着干你的活。');
  for (const state of ['connecting', 'login-required', 'empty']) {
    assert.equal(viewModel({ state }, { brand }).welcome, null, state);
  }
  // The mark already heads the sidebar: repeating it here would be decoration.
  assert.equal(viewModel({ state: 'provisioning' }, { brand }).welcome.mark, undefined);
  // A working, single-machine client has already met the user.
  assert.equal(viewModel(SOLO, { brand }).welcome, null);
  assert.equal(viewModel(READY, { brand }).welcome, null);
  // Without a brand script (as in a bare test run) nothing is invented.
  assert.equal(viewModel({ state: 'provisioning' }).welcome, null);
});

test('the kernel fact distinguishes the four states worth telling apart', () => {
  assert.equal(kernelFact(null), '-');
  assert.equal(kernelFact({ error: 'boom' }), '-');
  assert.equal(kernelFact({ installed: false }), '未安装');
  assert.equal(kernelFact({ installed: true, version: '0.2.0-rc.2', reachable: false }), '0.2.0-rc.2 · 未运行');
  assert.equal(kernelFact({ installed: true, version: '0.2.0-rc.2', reachable: true, service: { loaded: true } }), '0.2.0-rc.2 · 常驻');
  assert.equal(kernelFact({ installed: true, version: '0.2.0-rc.2', reachable: true, service: { loaded: false } }), '0.2.0-rc.2 · 外部托管');
});

test('diagnostics fold the internals instead of putting them on the front page', () => {
  const rows = diagnosticsOf(READY);
  const labels = plain(rows.map((row) => row.label));
  assert.deepEqual(labels, ['本机', '本机名', '服务器', '协议', '网络引擎', '引擎构建']);
  assert.equal(rows.find((row) => row.label === '本机').value, '0.2.0-rc.2 · 外部托管');
  // With no address in force the row says so rather than leaving the reader to guess: it
  // is the row that explains a first-run failure.
  assert.equal(rows.find((row) => row.label === '服务器').value, '还没有地址');
  // The front page must not carry any of it: the status line never mentions versions.
  const model = viewModel(READY);
  assert.equal(/v0\.78\.1|0\.2\.0-rc\.2|协议/.test(model.status.detail), false);
  assert.equal(model.layout.diagnostics, false, 'folded by default');
});

test('diagnostics name the build, so two builds of one version are told apart', () => {
  const withBuild = diagnosticsOf({ ...READY, app: { version: '0.4.4', build: '1234' } });
  assert.deepEqual(plain(withBuild[0]), { label: '本窗口', value: '0.4.4 (构建 1234)' });
  // A running checkout has no build number, so the row says only what it knows instead of
  // inventing one.
  const checkout = diagnosticsOf({ ...READY, app: { version: '0.4.4', build: '' } });
  assert.deepEqual(plain(checkout[0]), { label: '本窗口', value: '0.4.4' });
  // And a snapshot that could not name its window carries no such row at all.
  assert.equal(diagnosticsOf(READY).some((row) => row.label === '本窗口'), false);
});

test('the sidebar can be hidden and brought back', () => {
  assert.equal(viewModel(READY, { sidebar: false }).layout.sidebar, false);
  assert.equal(viewModel(READY).layout.sidebar, true);
});

test('the identity line is about the machine, not the internals', () => {
  const model = viewModel(READY);
  assert.equal(model.identity.name, 'studio-mac');
  assert.equal(model.identity.ip, '100.64.1.81');
  // Before the network is up the local host still names the machine.
  assert.equal(viewModel(SOLO).identity.name, 'studio-mac');
  assert.equal(viewModel({ state: 'provisioning' }).identity.name, '尚未加入网络');
});

test('the account chip keeps the network apart from the app', () => {
  const solo = accountOf(SOLO, 'local');
  assert.equal(solo.name, '未登录');
  assert.deepEqual(plain(solo.action), { id: 'connect', label: '登录' });

  const signingIn = accountOf({ local: LOCAL, fleet: { state: 'login-required' }, server: { url: 'https://netbird.corp.example:443', host: 'netbird.corp.example', source: 'bundled' } }, 'login-required');
  assert.equal(signingIn.name, '等待登录');
  assert.equal(signingIn.line, '本机不受影响', 'the app is not what is waiting');
  assert.deepEqual(plain(signingIn.action), { id: 'connect', label: '登录' });

  // The chip leads to the address when there is none: the state itself is not something
  // the person can clear by pressing 登录 again.
  const noAddress = accountOf({ local: LOCAL, fleet: { state: 'login-required' }, server: { url: '', source: 'none' } }, 'login-required');
  assert.equal(noAddress.name, '还没有服务器地址');
  assert.deepEqual(plain(noAddress.action), { id: 'set-server', label: '设置服务器' });

  const connected = accountOf({ ...READY, fleet: { state: 'ready' } }, 'ready');
  assert.equal(connected.name, 'studio-mac');
  assert.equal(connected.line, '3 台可达');
  assert.equal(connected.action, null);

  const preparing = accountOf({ local: { ...LOCAL, state: 'needs-install' } }, 'provisioning');
  assert.equal(preparing.disabled, true);
  assert.match(preparing.line, /还没装好/);
});

test('the status line counts in the user language, not the engine log language', () => {
  // The supervisor's note is engine-facing English and must not reach the screen.
  const ready = viewModel({ ...READY, detail: '6 machines reachable by registration' });
  assert.equal(ready.status.detail, '3 台可达');
  assert.equal(/registration|reachable/.test(ready.status.detail), false);
  assert.equal(viewModel({ state: 'ready', entries: [] }).status.detail, '');
  // On a failure the engine's exact words are the diagnosis, and they belong to the
  // error panel rather than to the status line.
  const broken = viewModel({ state: 'error', detail: 'engine protocol 2 does not match the required 1' });
  assert.equal(broken.status.detail, '');
  assert.match(broken.detail.state.body, /protocol 2/);
});

test('this machine is the row the shell marked, and no name is consulted', () => {
  // The shell marks this machine's row after matching the fleet's records against this
  // machine's addresses; the projection only reads that mark. Names in the snapshot - the
  // engine's, the local block's, the record's - cannot move a row into 本机.
  const model = viewModel({
    ...READY,
    self: { machine: 'LeoDeMacBook-Pro.local', ip: '100.64.1.81', host: 'dsh.elsewhere.netbird' },
    local: { ...LOCAL, machine: 'LeoDeMacBook-Pro.local', host: 'dsh.elsewhere.netbird' },
  });
  assert.deepEqual(plain(model.sidebar.groups.map((group) => [group.id, group.machines.length])), [
    ['self', 1],
    ['ours', 2],
  ]);
  assert.equal(model.sidebar.groups[0].machines[0].name, 'studio-mac', 'the marked row, not the named one');
  // No mark, no 本机: an unmarked list is all other machines, even if a name would match.
  const unmarked = viewModel({
    ...READY,
    entries: [entry('studio-mac', '100.64.1.81'), entry('tower-lab', '100.64.1.74'), entry('imac-office', '100.64.1.23', 302)],
  });
  assert.deepEqual(plain(unmarked.sidebar.groups.map((group) => group.id)), ['ours']);
  assert.equal(unmarked.sidebar.groups[0].machines.length, 3);
});

test('the row the client built for itself is this machine, whatever the fleet calls it', () => {
  // The live shape: the engine's own name for this machine carries a collision suffix
  // (`workstation-189-193`), while the local row is built from the host name
  // (`workstation-pro`). Grouping by authority alone filed the current machine under
  // "其他机器" - the client's own row is this machine by construction.
  const localRow = {
    ...entry('workstation-pro', '127.0.0.1'),
    url: 'http://127.0.0.1:3080/',
    local: true,
  };
  const model = viewModel({
    state: 'ready',
    local: { ...LOCAL, machine: 'workstation-pro', host: 'dsh.workstation-pro.netbird' },
    fleet: { state: 'ready', detail: '5 machines reachable by registration' },
    self: { machine: 'workstation-189-193', fqdn: 'workstation-189-193.netbird', host: 'dsh.workstation-189-193.netbird' },
    registered: 6,
    entries: [localRow, entry('tower-lab', '100.64.1.74')],
  });
  assert.deepEqual(plain(model.sidebar.groups.map((group) => [group.id, group.title, group.machines.length])), [
    ['self', '本机', 1],
    ['ours', '其他机器', 1],
  ]);
  assert.equal(model.sidebar.groups[0].machines[0].name, 'workstation-pro');
  assert.equal(model.sidebar.groups[0].machines[0].isLocal, true);
  // Grouping on its own: the local mark outranks a host that does not match.
  const flagged = [{ ...entry('workstation-pro', '127.0.0.1'), name: 'workstation-pro', isLocal: true }];
  assert.equal(groupMachines(flagged, '', 'ready')[0].title, '本机');
});

test('the machine is written with one name: the one the list shows', () => {
  // The engine knows this enrollment by a suffixed name while the list shows the authority
  // the host answered for. The title, the diagnostics line and the account chip must all
  // say what the row says - three names for one machine is how the screen contradicted
  // itself.
  const model = viewModel({
    ...READY,
    local: { ...LOCAL, machine: 'studio-mac', host: 'dsh.studio-mac.netbird' },
    self: { machine: 'workstation-189-193', fqdn: 'workstation-189-193.netbird', ip: '100.64.1.93' },
    entries: [{ ...entry('studio-mac', '127.0.0.1'), url: 'http://127.0.0.1:3080/', local: true }, entry('tower-lab', '100.64.1.74')],
  });
  assert.equal(model.detail.windowMachine.name, 'studio-mac');
  assert.equal(model.identity.name, 'studio-mac');
  assert.equal(model.account.name, 'studio-mac');
  // And with no local block at all, the engine's record is still better than nothing.
  const withoutLocal = viewModel({ state: 'ready', self: { machine: 'anywhere-shell' }, entries: [entry('tower-lab', '100.64.1.74')] });
  assert.equal(withoutLocal.detail.windowMachine.name, 'anywhere-shell');
  assert.equal(withoutLocal.identity.name, 'anywhere-shell');
});

test('groupMachines and resolveSelection are usable on their own', () => {
  // The shape groupMachines is contracted for: the normalised machines the view model
  // builds, where the display name is `name` (an entry on the wire calls it `machine`).
  const machines = [
    { ...entry('studio-mac', '1.1.1.1'), name: 'studio-mac', isLocal: true },
    { ...entry('tower-lab', '2.2.2.2'), name: 'tower-lab' },
  ];
  assert.equal(groupMachines(machines, '', 'ready').length, 2);
  assert.equal(groupMachines(machines.map((machine) => ({ ...machine, isLocal: false })), '', 'ready').length, 1);
  assert.equal(groupMachines([], '', 'off')[0].title, '其他机器');
  assert.equal(groupMachines([], '', 'off')[0].action.id, 'connect');
  assert.equal(resolveSelection(machines, ''), 'dsh.studio-mac.netbird');
  assert.equal(resolveSelection([], 'x'), '');
  assert.equal(statusOf({ state: 'ready' }).tone, 'good');
});