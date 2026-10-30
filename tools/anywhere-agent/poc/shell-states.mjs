#!/usr/bin/env node
/**
 * Interface check: the tab strip, the home and the settings page, asserted in one launch.
 *
 * The rules live in `src/tabs.mjs` (unit-tested in `test/tabs.test.mjs`). This run
 * proves the wiring: that the renderer draws what the main process pushes, that
 * clicking a card opens exactly one tab, that closing the last tab returns to the home
 * instead of an empty window, and that there is no address bar and no aggregate status
 * anywhere on screen.
 *
 * The state is *selected*, never sequenced, so the run cannot depend on how often the
 * renderer polls. It never touches the machine it runs on: scripted states mean the
 * client skips preparing, installing or probing anything.
 *
 * Usage:
 *   node poc/shell-states.mjs [--electron <path>] [--out <dir>]
 */

import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = join(HERE, '..', 'shell');
const FIXTURE = pathToFileURL(join(HERE, 'fixtures', 'blank.html')).href;

function parseArgs(argv) {
  const args = { electron: process.env.AW_ELECTRON ?? '', out: join(HERE, 'evidence') };
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
mkdirSync(join(HERE, 'fixtures'), { recursive: true });
writeFileSync(
  join(HERE, 'fixtures', 'blank.html'),
  '<!doctype html><meta charset="utf-8"><title>Machine Workspace</title><h1 id="ok">workspace</h1>',
  'utf8',
);

const ENGINE = { protocol: 1, helper: '0.1.1', netbird: 'v0.78.1' };
const KERNEL = { installed: true, version: '0.2.0-rc.2', reachable: true, service: { label: 'org.dsh.web', loaded: true } };
const LOCAL = { state: 'ready', detail: '', machine: 'studio-mac', host: 'dsh.studio-mac.netbird', url: FIXTURE };
const entry = (machine, statusCode) => ({
  host: `dsh.${machine}.netbird`,
  machine,
  ip: '100.64.1.10',
  url: FIXTURE,
  statusCode,
});

const SNAPSHOTS = {
  ready: {
    local: LOCAL,
    fleet: { state: 'ready', detail: 'fleet ready' },
    engine: ENGINE,
    self: { machine: 'studio-mac', ip: '100.64.1.10', interfaceType: 'Userspace', host: 'dsh.studio-mac.netbird' },
    kernel: KERNEL,
    registered: 3,
    app: { version: '0.4.10', build: '118' },
    server: { line: 'netbird.example.com', hasUrl: true },
    // One service is being driven by an agent: the badge and the operating bar have to
    // exist while it is on screen and disappear when it is not.
    agentServiceId: 'machine:dsh.tower-lab.netbird',
    entries: [
      { ...entry('studio-mac', 200), local: true },
      entry('tower-lab', 200),
      entry('imac-office', 302),
    ],
  },
  empty: {
    local: LOCAL,
    fleet: { state: 'empty', detail: '还没有其他机器' },
    engine: ENGINE,
    self: { machine: 'studio-mac', ip: '100.64.1.10', interfaceType: 'Userspace', host: 'dsh.studio-mac.netbird' },
    kernel: KERNEL,
    registered: 0,
    app: { version: '0.4.10', build: '118' },
    server: { line: 'netbird.example.com', hasUrl: true },
    entries: [],
  },
  offline: {
    local: { ...LOCAL, state: 'ready' },
    fleet: { state: 'error', detail: '连不上' },
    engine: ENGINE,
    self: null,
    kernel: KERNEL,
    registered: 0,
    detail: '私网连接断开了',
    app: { version: '0.4.10', build: '118' },
    server: { line: 'netbird.example.com', hasUrl: true },
    entries: [],
  },
  'login-required': {
    local: LOCAL,
    fleet: { state: 'login-required', detail: '需要登录' },
    engine: ENGINE,
    self: null,
    kernel: KERNEL,
    registered: 3,
    loginUrl: 'https://netbird.example.com/sso?token=stub',
    app: { version: '0.4.10', build: '118' },
    server: { line: 'netbird.example.com', hasUrl: true },
    entries: [entry('tower-lab', 200)],
  },
  provisioning: {
    local: { state: 'needs-install', detail: '这里缺 Node', machine: '', host: '', url: '', command: 'bash install.sh' },
    fleet: { state: 'off', detail: '' },
    engine: null,
    self: null,
    kernel: { installed: false, version: '', reachable: false },
    registered: 0,
    app: { version: '0.4.10', build: '118' },
    server: { line: '', hasUrl: false },
    entries: [],
  },
};

// A web service is an ordinary http address: the catalogue refuses anything else, so the
// fixture is served over loopback instead of file://.
const site = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><meta charset="utf-8"><title>Wiki</title><h1 id="wiki">wiki</h1>');
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const SITE_URL = `http://127.0.0.1:${site.address().port}/`;

const statesFile = join(args.out, 'states.json');
writeFileSync(statesFile, JSON.stringify(SNAPSHOTS, null, 2), 'utf8');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    process.stdout.write(`  FAIL ${name}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}\n`);
  }
}

const userData = join(args.out, 'userdata');
mkdirSync(userData, { recursive: true });
// A previous run leaves the tabs it ended with. The window restores them on the first
// usable reading, so a check that starts by counting tabs must start from none.
rmSync(join(userData, 'tabs.json'), { force: true });
// One web service in the catalogue. The transport already reaches anything NetBird's DNS
// answers; this proves the tab draws it and loads its page.
writeFileSync(
  join(args.out, 'services.json'),
  JSON.stringify({ services: [{ id: 'web:wiki', name: 'Wiki', subtitle: '内部文档', url: SITE_URL }] }, null, 2),
  'utf8',
);

const stderrLog = createWriteStream(join(args.out, 'app-stderr.log'));

/**
 * One launch, one scheme.
 *
 * The interface is checked in both schemes because the token sheet and the dark overrides
 * are a real surface: a window that is unreadable in dark is a broken window, and the DOM
 * cannot tell you that - the screenshots can.
 */
async function runScheme(scheme) {
  process.stdout.write(`\nscheme=${scheme}\n`);
  // The previous scheme ended on whatever tabs it finished with; the window restores
  // them, so the run that counts tabs must start from none.
  rmSync(join(userData, 'tabs.json'), { force: true });
const app = await electron.launch({
  executablePath: args.electron,
  args: [
    `--user-data-dir=${userData}`,
    // Chromium's sandbox cannot initialise inside a restricted CI/agent shell, and a GPU
    // process that cannot start is fatal to the launch. Neither flag belongs to the
    // product: they are switches on this development run only.
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-sandbox',
    SHELL_DIR,
    '--states',
    statesFile,
    '--services',
    join(args.out, 'services.json'),
    '--dir',
    userData,
  ],
  colorScheme: scheme,
});

try {
  // The app's own stderr is the only place a refused flag or an unread catalogue shows
  // up, so it is kept beside the screenshots.
  app.process().stderr?.on('data', (chunk) => {
    stderrLog.write(String(chunk));
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => window.anywhere.refresh('ready'));

  // The window opens on the home, and the home is the only tab.
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 1, null, { timeout: 15_000 });
  check('opens on one tab', await page.locator('.tab').count(), 1);
  check('the tab is the home', await page.locator('.tab .tab-title').first().innerText(), '首页');
  check('home is on screen', await page.locator('#home').isVisible(), true);

  // No address bar, no aggregate status: the two things that made the old shell read
  // as a browser or as a dashboard.
  check('no address bar', await page.locator('.omnibox, #address').count(), 0);
  const text = await page.locator('body').innerText();
  check('no reachability aggregate', /台可达|已连接 ·/.test(text), false);

  // One card per machine, grouped, with the needs-login machine dimmed.
  check('machine cards', await page.locator('.card[data-service-id^="machine:"]').count(), 3);
  check(
    'needs-login card is dimmed',
    await page.locator('.card[data-service-id="machine:dsh.imac-office.netbird"]').getAttribute('data-dim'),
    'true',
  );

  // Opening a service adds exactly one tab and takes over the page area.
  await page.click('.card[data-service-id="machine:dsh.tower-lab.netbird"]');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 2, null, { timeout: 15_000 });
  check('service tab opened', await page.locator('.tab').count(), 2);
  check('service tab is active', await page.locator('.tab[data-active="true"] .tab-title').innerText(), 'tower-lab');
  check('home stepped aside', await page.locator('#home').isHidden(), true);
  // The native page is a separate layer: a renderer screenshot cannot show it, so the
  // main process reports what it actually mounted.
  check(
    'workspace view attached to the tab',
    (await app.evaluate(() => globalThis.__awSnapshot?.workspace?.host ?? '')),
    'dsh.tower-lab.netbird',
  );
  check(
    'workspace page really loaded',
    (await app.evaluate(() => globalThis.__awWorkspace?.webContents.getURL() ?? '')).endsWith('blank.html'),
    true,
  );
  check('the agent-driven tab carries the A badge', await page.locator('.tab-agent').count(), 1);
  check('the operating bar is on screen', await page.locator('#agent-bar').isVisible(), true);
  check(
    'the bar names the service it is driving',
    /tower-lab/.test(await page.locator('#agent-text').innerText()),
    true,
  );
  await page.screenshot({ path: join(args.out, `tab-service-${scheme}.png`) });

  // A web service opens the same way a machine does, and its page is a native view too.
  await page.click('.tab[data-active="true"] .tab-close');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 1, null, { timeout: 15_000 });
  check('web service card is listed', await page.locator('.card[data-service-id="web:wiki"]').count(), 1);
  await page.click('.card[data-service-id="web:wiki"]');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 2, null, { timeout: 15_000 });
  check('web tab opened', await page.locator('.tab').count(), 2);
  // The tab exists before its page commits, so the URL is polled rather than read once.
  let webUrl = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    webUrl = await app.evaluate(() => globalThis.__awWorkspace?.webContents.getURL() ?? '');
    if (webUrl !== '') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  check('web page really loaded', webUrl.startsWith(SITE_URL), true);
  await page.click('.tab[data-active="true"] .tab-close');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 1, null, { timeout: 15_000 });

  // Opening the same service again activates the tab it already has.
  await page.click('#tab-new');
  await page.waitForFunction(
    () => document.querySelector('.tab[data-active="true"] .tab-title')?.textContent === '首页',
    null,
    { timeout: 10_000 },
  );
  check('the bar is gone once no agent-driven tab is on screen', await page.locator('#agent-bar').isHidden(), true);
  await page.click('.card[data-service-id="machine:dsh.tower-lab.netbird"]');
  await page.waitForTimeout(900);
  check('a service has one tab', await page.locator('.tab').count(), 2);

  // Closing the last service tab returns to the home; the window stays open.
  await page.click('.tab[data-active="true"] .tab-close');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 1, null, { timeout: 15_000 });
  check('closing the last tab returns home', await page.locator('.tab[data-active="true"] .tab-title').innerText(), '首页');
  check('window still open', await page.locator('#home').isVisible(), true);
  check('workspace detached on close', await app.evaluate(() => globalThis.__awSnapshot?.workspace ?? null), null);
  await page.screenshot({ path: join(args.out, `home-${scheme}.png`) });

  // The keyboard model: a number key selects by position, and a number with no tab
  // behind it changes nothing (a shortcut that silently jumps somewhere is worse than one
  // that does nothing).
  await page.click('#tab-new');
  await page.waitForFunction(
    () => document.querySelector('.tab[data-active="true"] .tab-title')?.textContent === '首页',
    null,
    { timeout: 10_000 },
  );
  check('the bar is gone once no agent-driven tab is on screen', await page.locator('#agent-bar').isHidden(), true);
  await page.click('.card[data-service-id="machine:dsh.tower-lab.netbird"]');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 2, null, { timeout: 15_000 });
  await page.click('#tab-new');
  await page.waitForFunction(
    () => document.querySelector('.tab[data-active="true"] .tab-title')?.textContent === '首页',
    null,
    { timeout: 10_000 },
  );
  await page.click('.card[data-service-id="web:wiki"]');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 3, null, { timeout: 15_000 });
  const titles = await page.locator('.tab .tab-title').allInnerTexts();
  for (const [index, expected] of titles.entries()) {
    await page.keyboard.press(`Meta+${index + 1}`);
    await page.waitForTimeout(250);
    check(`⌘${index + 1} selects tab ${index + 1}`, await page.locator('.tab[data-active="true"] .tab-title').innerText(), expected);
  }
  await page.keyboard.press('Meta+9');
  await page.waitForTimeout(250);
  check('a number with no tab behind it changes nothing', await page.locator('.tab[data-active="true"] .tab-title').innerText(), titles[titles.length - 1]);

  // Settings is a tab, and it carries the diagnostics that used to be scattered.
  await page.click('#open-settings');
  await page.waitForFunction(() => !document.getElementById('settings')?.hidden, null, { timeout: 10_000 });
  check('settings is a tab', await page.locator('.tab[data-active="true"] .tab-title').innerText(), '设置');
  check('settings has rows', (await page.locator('#settings .row').count()) > 2, true);
  // The tab shell has no account chip, so turning the private network on lives here.
  await page.click('.settings-nav button[data-section="network"]');
  await page.waitForTimeout(250);
  // Connected or not, the row is the way in and out of the private network; which of the
  // two words it carries depends on where the fleet already is.
  check(
    'the network group offers the way in or out',
    /连接其他机器|断开/.test(await page.locator('#settings .row-action').first().innerText()),
    true,
  );
  await page.click('.settings-nav button[data-section="appearance"]');
  await page.screenshot({ path: join(args.out, `settings-${scheme}.png`) });

  // Narrow window: the grid collapses and nothing overflows sideways.
  await page.setViewportSize({ width: 640, height: 600 });
  await page.click('#tab-new');
  await page.waitForFunction(() => !document.getElementById('home')?.hidden, null, { timeout: 10_000 });
  await page.waitForTimeout(300);
  check('no horizontal overflow at 640', await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: join(args.out, `home-640-${scheme}.png`) });

  // The one window-wide state left: the local host is not ready.
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.evaluate(() => window.anywhere.refresh('provisioning'));
  await page.waitForFunction(
    () => document.getElementById('banner') && !document.getElementById('banner').hidden,
    null,
    { timeout: 10_000 },
  );
  check('banner names the local problem', (await page.locator('#banner-title').innerText()).length > 0, true);
  check('banner carries an action', (await page.locator('#banner-actions .button').count()) > 0, true);
  await page.screenshot({ path: join(args.out, `provisioning-${scheme}.png`) });

  // Every state, in this scheme, with its own screenshot. Order matters: `offline` runs
  // after `ready`, because the home keeps the last list it saw when the fleet drops.
  for (const state of ['ready', 'empty', 'offline', 'login-required']) {
    await page.evaluate((select) => window.anywhere.refresh(select), state);
    await page.waitForTimeout(700);
    const cards = await page.locator('.card').count();
    const banner = !(await page.locator('#banner').isHidden());
    process.stdout.write(`  ${state}: cards=${cards} banner=${banner}\n`);
    if (state === 'ready') {
      check(`${state}: every service is a card`, cards, 4);
      check(`${state}: no banner when healthy`, banner, false);
    }
    if (state === 'empty') {
      check(`${state}: only the catalogue remains`, cards, 1);
    }
    if (state === 'offline') {
      check(`${state}: cards survive a disconnect`, cards, 4);
      check(`${state}: the disconnect is on screen`, banner, true);
    }
    if (state === 'login-required') {
      check(`${state}: the person is asked to sign in`, banner, true);
    }
    check(`${state}: home is on screen`, await page.locator('#home').isVisible(), true);
    await page.screenshot({ path: join(args.out, `state-${state}-${scheme}.png`) });
  }
} finally {
  await app.close();
}
}

for (const scheme of ['light', 'dark']) {
  await runScheme(scheme);
}
stderrLog.end();
site.close();

process.stdout.write(failures === 0 ? `\nshell-states: all checks passed (${args.out})\n` : `\nshell-states: ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
