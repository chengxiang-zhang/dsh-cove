#!/usr/bin/env node
/**
 * Interface check: every screen state, asserted in one launch.
 *
 * The logic of what each state looks like is unit-tested in test/view.test.mjs. This
 * run exists to prove the wiring: that the router applies the model to real elements,
 * that the generated tokens take effect in both schemes, and that the main process and
 * the screen agree. It asserts on the DOM, and a failure prints which selector
 * disagreed instead of a screenshot for someone to squint at.
 *
 * The state is *selected*, never sequenced, so the run cannot depend on how often the
 * renderer polls. It also never touches the machine it runs on: scripted states mean
 * the client skips preparing, installing or probing anything (see shell/main.mjs).
 *
 * Usage:
 *   node poc/shell-states.mjs [--electron <path>] [--out <dir>]
 */

import { _electron as electron } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = join(HERE, '..', 'shell');

function parseArgs(argv) {
  const args = {
    electron: process.env.AW_ELECTRON ?? '',
    out: join(HERE, 'evidence'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--electron') {
      args.electron = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--out') {
      args.out = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.out, { recursive: true });

const ENGINE = { protocol: 1, helper: '0.1.1', netbird: 'v0.78.1' };
const SELF = { machine: 'studio-mac', ip: '100.64.1.81', interfaceType: 'Userspace' };
const KERNEL = { installed: true, version: '0.2.0-rc.2', reachable: true, service: { label: 'org.dsh.web', loaded: true } };
const LOCAL = { state: 'ready', detail: '', machine: 'studio-mac', host: 'dsh.studio-mac.netbird', url: 'http://127.0.0.1:3080/' };
const entry = (machine, ip, statusCode) => ({
  host: `dsh.${machine}.netbird`,
  machine,
  ip,
  url: `http://dsh.${machine}.netbird/`,
  statusCode,
});
/** This machine's own row, which is present whatever the network is doing. */
const LOCAL_ROW = { ...entry('studio-mac', '127.0.0.1'), url: 'http://127.0.0.1:3080/', local: true };

/** One snapshot per state, keyed by the state name the check selects. */
const SNAPSHOTS = {
  provisioning: {
    state: 'provisioning',
    engine: null,
    self: null,
    entries: [],
    registered: 0,
    local: {
      ...LOCAL,
      state: 'needs-install',
      detail: 'this machine has no Node 22 or newer this app can see, and the app installs nothing itself',
      command: 'curl -fsSL https://channel.example/install.sh | sh',
    },
    fleet: { state: 'off', detail: '' },
  },
  local: {
    state: 'local',
    engine: null,
    self: null,
    registered: 1,
    entries: [{ ...LOCAL_ROW, unread: 3 }],
    local: LOCAL,
    fleet: { state: 'off', detail: '' },
    kernel: KERNEL,
  },
  connecting: {
    state: 'connecting',
    engine: ENGINE,
    self: null,
    entries: [LOCAL_ROW],
    registered: 1,
    local: LOCAL,
    fleet: { state: 'connecting', detail: '' },
  },
  'login-required': {
    state: 'login-required',
    engine: ENGINE,
    self: null,
    entries: [LOCAL_ROW],
    registered: 1,
    local: LOCAL,
    fleet: { state: 'login-required', detail: '' },
    loginUrl: 'https://netbird.example/oauth2/auth?audience=netbird-cli&client_id=netbird-cli',
    server: { url: 'https://netbird.corp.example:443', host: 'netbird.corp.example', source: 'bundled', isCustom: false },
  },
  // The shipped desktop's state before this change - the fleet asked for with no
  // address to dial - is covered by the real run instead of here: this seam renders one
  // fixture per product state, and that case is the same product state with a different
  // fact. `poc/walkthrough.mjs` drives it end to end, where the app produces it itself.
  empty: {
    state: 'empty',
    engine: ENGINE,
    self: SELF,
    entries: [LOCAL_ROW],
    registered: 1,
    local: LOCAL,
    fleet: { state: 'empty', detail: '' },
  },
  error: {
    state: 'error',
    engine: ENGINE,
    detail: 'engine protocol 2 does not match the required 1',
    entries: [LOCAL_ROW],
    registered: 1,
    local: LOCAL,
    fleet: { state: 'error', detail: 'engine protocol 2 does not match the required 1' },
  },
  ready: {
    state: 'ready',
    engine: ENGINE,
    self: SELF,
    kernel: KERNEL,
    registered: 3,
    local: LOCAL,
    fleet: { state: 'ready', detail: '3 machines reachable by registration' },
    entries: [
      // The shell marks this machine's row by address; the fixture says the shell did.
      LOCAL_ROW,
      { ...entry('tower-lab', '100.64.1.74'), unread: 2 },
      entry('imac-office', '100.64.1.23', 302),
    ],
  },
};

/**
 * What the DOM must show per state: the tone and label of the status line, how many
 * machines the sidebar holds, the detail panel's title and actions, whether the
 * embedded workspace covers the pane, and what the account chip says.
 */
const EXPECTED = {
  provisioning: {
    tone: 'busy',
    label: '正在准备',
    machines: 0,
    title: '本机还没装好',
    actions: 2,
    actionLabels: ['在终端运行安装器', '重试'],
    workspace: false,
    welcome: true,
    account: '正在准备本机',
  },
  local: {
    tone: 'good',
    label: '本机可用',
    machines: 1,
    title: '要打开哪台机器?',
    kind: 'home',
    actions: 1,
    workspace: false,
    welcome: false,
    account: '未登录',
    unread: '3',
    // The home's primary action opens this machine, which is what the click below does.
    opens: true,
  },
  connecting: {
    tone: 'busy',
    label: '正在接入',
    machines: 1,
    title: '正在接入',
    actions: 1,
    actionLabels: ['改用本机'],
    workspace: false,
    welcome: false,
    account: '正在接入',
  },
  'login-required': {
    tone: 'attention',
    label: '等待登录',
    machines: 1,
    title: '登录',
    actions: 1,
    actionLabels: ['登录'],
    workspace: false,
    // The hand-off link is short-lived and re-minted on the click, so no element may
    // show it. The snapshot carries it for the main process; the screen must not.
    noUrlOnScreen: true,
    // The address is named on the panel: it is the fact behind the failure the reader
    // may be looking at, and the one they can change.
    serverLine: '服务器：netbird.corp.example',
    welcome: false,
    account: '等待登录',
  },
  empty: {
    tone: 'idle',
    label: '没有其他机器',
    machines: 1,
    title: '没有看到其他机器',
    actions: 1,
    workspace: false,
    welcome: false,
    account: '没有其他机器',
  },
  error: {
    tone: 'bad',
    label: '连不上',
    machines: 1,
    title: '连不上',
    actions: 2,
    actionLabels: ['重试', '设置服务器'],
    workspace: false,
    detail: true,
    welcome: false,
    account: '连不上网络',
  },
  ready: {
    tone: 'good',
    label: '已连接',
    machines: 3,
    title: '要打开哪台机器?',
    kind: 'home',
    actions: 1,
    workspace: false,
    groups: ['本机', '其他机器'],
    badge: '需登录',
    unread: '2',
    welcome: false,
    account: 'studio-mac',
    opens: true,
  },
};

const statesFile = join(args.out, 'states.json');
writeFileSync(statesFile, `${JSON.stringify(SNAPSHOTS, null, 2)}\n`);

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) {
    failures += 1;
  }
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}\n`);
}

for (const scheme of ['dark', 'light']) {
  // Chromium's own state (singleton lock, caches) goes beside the evidence rather than
  // in the user's Library, so the check can run in a bare checkout and leaves nothing
  // behind when it is deleted.
  const userData = join(args.out, `userdata-${scheme}`);
  mkdirSync(userData, { recursive: true });
  const app = await electron.launch({
    executablePath: args.electron,
    args: [
      `--user-data-dir=${userData}`,
      // Chromium's own sandbox cannot initialise inside the restricted environment this
      // check is often run from (a CI runner, a container, a sandboxed agent shell), and
      // a GPU process that cannot start is fatal to the launch. Neither flag belongs to
      // the product: they are switches on this development run only.
      '--no-sandbox',
      '--disable-gpu',
      '--disable-gpu-sandbox',
      SHELL_DIR,
      '--states',
      statesFile,
      '--dir',
      userData,
    ],
    // The page's prefers-color-scheme, which the generated token sheet follows.
    colorScheme: scheme,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  process.stdout.write(`scheme=${scheme}\n`);

  for (const [state, expected] of Object.entries(EXPECTED)) {
    await page.evaluate((select) => window.anywhere.refresh(select), state);
    await page.waitForFunction((want) => document.getElementById('status-label')?.innerText === want, expected.label, {
      timeout: 10_000,
    });

    process.stdout.write(` ${state}\n`);
    check('status tone', await page.locator('#status').getAttribute('data-tone'), expected.tone);
    check('status label', await page.locator('#status-label').innerText(), expected.label);
    check('machines', await page.locator('#groups .machine').count(), expected.machines);
    // The workspace covers the pane when there is one; the panel is the explanation
    // when there is not.
    check('state panel hidden', await page.locator('#state-panel').isHidden(), expected.workspace);
    if (!expected.workspace) {
      check('panel state', await page.locator('#state-panel').getAttribute('data-state'), expected.panelState ?? state);
      if (expected.kind) {
        // The front door and a notice are different screens of the same pane.
        check('panel kind', await page.locator('#state-panel').getAttribute('data-kind'), expected.kind);
      }
      check('panel title', await page.locator('#state-title').innerText(), expected.title);
      check('actions', await page.locator('#state-actions button').count(), expected.actions);
      // Every action is addressable, and none of them is the placeholder id the label
      // table used to produce: a button whose id is `action-undefined` is also a button
      // whose click runs nothing, which is a dead control that looks alive.
      const actionIds = await page.locator('#state-actions button').evaluateAll((nodes) => nodes.map((node) => node.id));
      check('actions have real ids', actionIds.includes('action-undefined'), false);
      check('action ids are unique', new Set(actionIds).size, actionIds.length);
    }
    if (expected.serverLine) {
      check('the panel names the server', await page.locator('#state-server').innerText(), expected.serverLine);
    }
    // Every state in this loop is rendered on the home (the workspace case is asserted
    // by the `opens` block below), so the rail's mark belongs on the first entry.
    check('rail marks the current view', await page.locator('#rail-machines').getAttribute('data-active'), 'true');
    check('new-session entry availability', await page.locator('#rail-session').isDisabled(), !(state === 'local' || state === 'ready'));
    check('rail appearance is always available', await page.locator('#rail-appearance').isDisabled(), false);

    // The badge is asserted before anything opens a machine: opening one clears its dot by
    // design (the host's feed is considered read), so a check that ran afterwards would be
    // asserting that the app failed to do what it is supposed to do.
    if (expected.badge) {
      check('sign-in badge', await page.locator('.machine-badge').first().innerText(), expected.badge);
    }
    if (expected.unread) {
      // The red mark carries the number of finished conversations, not just a dot.
      check('unread count on the row', await page.locator('#groups .machine-unread').first().innerText(), expected.unread);
      const row = page.locator('#groups .machine[data-unread="true"]').first();
      check('unread count in the accessible name', (await row.getAttribute('aria-label')).includes(`${expected.unread} 项新结果`), true);
    }
    if (expected.opens) {
      // The home's primary action is not decoration: pressing it puts the machine's
      // workspace over the pane and moves the rail's mark.
      await page.locator('#state-actions button').first().click();
      await page.waitForFunction(() => document.getElementById('state-panel')?.hidden === true, null, { timeout: 10_000 });
      check('working space covers the pane after the home action', await page.locator('#state-panel').isHidden(), true);
      check('rail follows into the workspace', await page.locator('#rail-session').getAttribute('data-active'), 'true');
      await page.screenshot({ path: join(args.out, `shell-state-${state}-workspace-${scheme}.png`) });
      // Back to the home, which is the state the rest of the assertions are about.
      await page.locator('#rail-machines').click();
      await page.waitForFunction(() => document.getElementById('state-panel')?.hidden === false, null, { timeout: 10_000 });
    }
    if (expected.actionLabels) {
      check(
        'action labels',
        (await page.locator('#state-actions button').allInnerTexts()).join('|'),
        expected.actionLabels.join('|'),
      );
    }
    if (expected.detail) {
      check('error detail quoted', (await page.locator('#state-body').innerText()).includes('protocol'), true);
    }
    if (expected.groups) {
      check('group titles', (await page.locator('.group-title').allInnerTexts()).join('|'), expected.groups.join('|'));
    }
    if (expected.noUrlOnScreen) {
      // There is no link element at all any more: the sign-in is a button, and the
      // URL lives for the moment between the click and the browser.
      check('no login url element', await page.locator('#login-url, .url-field').count(), 0);
      check('no url text in the window', /https?:\/\//.test(await page.locator('body').innerText()), false);
    }
    if (expected.account) {
      check('account chip names the network state', await page.locator('#account-name').innerText(), expected.account);
    }
    // Brand consistency is asserted, not eyeballed: the tagline appears only where the
    // user first meets the product, and it comes from the generated brand script.
    check('welcome shown', !(await page.locator('#welcome').isHidden()), expected.welcome === true);
    if (expected.welcome) {
      const tagline = await page.locator('#welcome-tagline').innerText();
      check('tagline is the product tagline', tagline.includes('接着干你的活'), true);
    }
    // Diagnostics are folded on every screen: internals are not front-page content.
    check('diagnostics folded', await page.locator('#diagnostics-rows').isHidden(), true);

    await page.screenshot({ path: join(args.out, `shell-state-${state}-${scheme}.png`) });
  }

  // The main process and the screen must agree; this is the assertion that was
  // missing when the screen looked right while the agent was stuck.
  // The window's frame, as the platform defines it: a toolbar above the body carrying the
  // toggle, the title, the status and refresh - status belongs where it is always visible,
  // not in a bottom bar that a moved window can hide.
  check('a toolbar frame exists', await page.locator('.toolbar').count(), 1);
  check('status lives in the toolbar', await page.locator('.toolbar #status').count(), 1);
  check('refresh lives in the toolbar', await page.locator('.toolbar #refresh').count(), 1);
  check('the toggle lives in the toolbar', await page.locator('.toolbar #sidebar-toggle').count(), 1);
  // The rail: one entry per view plus the two always-available ones, and it survives the
  // sidebar folding away because it is the app's navigation, not the list's.
  check('the rail exists', await page.locator('.rail').count(), 1);
  check('the rail has four entries', await page.locator('.rail .rail-button').count(), 4);
  await page.locator('#sidebar-toggle').click();
  check('the rail stays when the list folds', await page.locator('.rail .rail-button').count(), 4);
  check('the list is gone when it folds', await page.locator('#groups').isVisible(), false);
  await page.locator('#sidebar-toggle').click();
  check('the list comes back', await page.locator('#groups').isVisible(), true);
  check('the pane the workspace covers exists', await page.locator('#detail-body').count(), 1);
  // The account chip is the only place the private network is switched on, and it is
  // not a bottom bar carrying critical actions: it reports, and it opens a sign-in.
  check('the account chip is in the sidebar foot', await page.locator('.sidebar-foot #account').count(), 1);
  // Branding defers to content: the product's mark is not sprinkled through the window.
  check('no logo in the window', (await page.locator('.sidebar-mark, .toolbar-mark, .brand-mark').count()), 0);

  const mainSnapshot = await app.evaluate(() => globalThis.__awSnapshot ?? null);
  process.stdout.write(` main process snapshot: ${JSON.stringify(mainSnapshot)}\n`);
  check('main process reports ready', mainSnapshot?.state, 'ready');
  await app.close();
}

process.stdout.write(failures === 0 ? 'RESULT pass\n' : `RESULT fail (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);