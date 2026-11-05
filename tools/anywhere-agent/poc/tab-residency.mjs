#!/usr/bin/env node
/**
 * Tab residency check: switching tabs is a visibility change, not a reload.
 *
 * A tab's page is a resident `WebContentsView`. The contract this run asserts:
 *
 *   1. Switching away from a tab hides its page; the page is neither destroyed nor
 *      reloaded (no second request, same `webContents` id).
 *   2. Switching back shows the same page. This holds however long the tab was away -
 *      the old five-minute reload and ten-minute discard are gone, so a page left off
 *      screen is still the same page.
 *   3. The explicit refresh still reloads the page (the escape hatch for a screen that
 *      really is stuck).
 *   4. Closing a tab destroys its page.
 *
 * The pages are served locally and count their own loads, so "the page was reloaded" is a
 * request the server saw. States are scripted: no engine is started, no network is
 * dialled.
 *
 * Usage:
 *   node poc/tab-residency.mjs --electron <path> [--out <dir>] [--packaged]
 *
 * `--electron` is the Electron executable of the runtime this package is verified
 * against (or `AW_ELECTRON`). The repository does not vendor Electron.
 *
 * `--packaged` runs a built bundle instead of the source tree: Electron ignores an app
 * directory argument for a packaged app, so the argument is left out and the bundle's own
 * payload is what gets exercised.
 */

import { createServer } from 'node:http';
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = join(HERE, '..', 'shell');

function parseArgs(argv) {
  const args = { electron: process.env.AW_ELECTRON ?? '', out: join(HERE, 'evidence', 'tab-residency'), packaged: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--electron') {
      args.electron = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--out') {
      args.out = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--packaged') {
      args.packaged = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.electron === '') {
  process.stderr.write('missing Electron: pass --electron <path> or set AW_ELECTRON\n');
  process.exit(2);
}
mkdirSync(args.out, { recursive: true });

// Each served page counts the document requests it receives: a reload is a request, a
// hidden page that is shown again is not.
const loads = new Map();
const site = createServer((request, response) => {
  const path = String(request.url ?? '/').split('?')[0];
  loads.set(path, (loads.get(path) ?? 0) + 1);
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><meta charset="utf-8"><title>page ${path}</title>
<body style="font:14px -apple-system"><h1>${path}</h1><p>a page a person would be reading</p></body>`);
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${site.address().port}`;

const ENGINE = { protocol: 1, helper: '0.1.1', netbird: 'v0.78.1' };
const KERNEL = { installed: true, version: '0.2.0-rc.2', reachable: true, service: { label: 'org.dsh.web', loaded: true } };
const states = {
  ready: {
    local: { state: 'ready', detail: '', machine: 'studio-mac', host: 'dsh.a.netbird', url: `${base}/a` },
    fleet: { state: 'ready', detail: 'fleet ready' },
    engine: ENGINE,
    self: { machine: 'studio-mac', ip: '100.64.1.10', interfaceType: 'Userspace', host: 'dsh.a.netbird' },
    kernel: KERNEL,
    registered: 1,
    app: { version: '0.6.0', build: '1' },
    server: { line: 'netbird.example.com', hasUrl: true },
    entries: [
      { host: 'dsh.a.netbird', machine: 'machine-a', ip: '100.64.1.10', url: `${base}/a`, statusCode: 200, local: true },
      { host: 'dsh.b.netbird', machine: 'machine-b', ip: '100.64.1.11', url: `${base}/b`, statusCode: 200 },
    ],
  },
};
const statesFile = join(args.out, 'states.json');
writeFileSync(statesFile, JSON.stringify(states, null, 2), 'utf8');
const userData = join(args.out, 'userdata');
rmSync(userData, { recursive: true, force: true });
mkdirSync(userData, { recursive: true });
const servicesFile = join(args.out, 'services.json');
writeFileSync(servicesFile, JSON.stringify({ services: [] }, null, 2), 'utf8');
const stderrLog = createWriteStream(join(args.out, 'app-stderr.log'));

let failures = 0;
function check(name, ok, detail) {
  if (!ok) {
    failures += 1;
    process.stdout.write(`  FAIL ${name}${detail === undefined ? '' : `: ${detail}`}\n`);
    return;
  }
  process.stdout.write(`  ok   ${name}\n`);
}

const countOf = (path) => loads.get(path) ?? 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const app = await electron.launch({
  executablePath: args.electron,
  args: [
    `--user-data-dir=${userData}`,
    // Chromium's sandbox cannot initialise inside a restricted agent shell, and a GPU
    // process that cannot start is fatal to the launch. Switches on this run only.
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-sandbox',
    ...(args.packaged ? [] : [SHELL_DIR]),
    '--states',
    statesFile,
    '--services',
    servicesFile,
    '--dir',
    userData,
  ],
});

try {
  app.process().stderr?.on('data', (chunk) => stderrLog.write(String(chunk)));
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => window.anywhere.refresh('ready'));
  await page.waitForFunction(() => document.querySelectorAll('.card[data-service-id^="machine:"]').length > 0, null, {
    timeout: 15_000,
  });

  const viewOf = () => app.evaluate(() => {
    const view = globalThis.__awWorkspace;
    return view === null || view === undefined
      ? null
      : { id: view.webContents.id, url: view.webContents.getURL(), visible: view.getVisible() };
  });
  const alive = (id) => app.evaluate(({ webContents }, viewId) => {
    const contents = webContents.fromId(viewId);
    return contents !== null && contents !== undefined && !contents.isDestroyed();
  }, id);
  const activate = async (id) => {
    await page.click(`.tab[data-tab-id="${id}"]`);
    await sleep(700);
  };
  const openMachine = async (machine) => {
    if (await page.locator('.tab[data-tab-id="home"]').count()) {
      await activate('home');
    }
    await page.click(`.card[data-service-id="machine:dsh.${machine}.netbird"]`);
    await page.waitForFunction(() => document.querySelectorAll('.tab').length >= 2, null, { timeout: 15_000 });
    await sleep(700);
  };

  process.stdout.write('\na fixed tab loads its page once\n');
  await openMachine('a');
  const a0 = await viewOf();
  check('machine a opened its page', a0 !== null && a0.url === `${base}/a`, JSON.stringify(a0));
  check('the page was requested once', countOf('/a') === 1, String(countOf('/a')));

  process.stdout.write('\nleaving a tab hides its page instead of destroying it\n');
  await activate('home');
  check('the page process is still alive off screen', await alive(a0.id));
  check('leaving did not reload the page', countOf('/a') === 1, String(countOf('/a')));

  process.stdout.write('\ncoming back shows the same page\n');
  await activate('svc:machine:dsh.a.netbird');
  const a1 = await viewOf();
  check('the same web contents came back', a1 !== null && a1.id === a0.id, JSON.stringify(a1));
  check('coming back did not reload the page', countOf('/a') === 1, String(countOf('/a')));
  check('the page is on screen again', a1.visible === true, String(a1.visible));

  process.stdout.write('\nswitching between two tabs keeps both pages resident\n');
  await openMachine('b');
  const b0 = await viewOf();
  check('machine b opened a second page', b0 !== null && b0.id !== a0.id && b0.url === `${base}/b`, JSON.stringify(b0));
  for (let round = 0; round < 3; round += 1) {
    await activate('svc:machine:dsh.a.netbird');
    await activate('svc:machine:dsh.b.netbird');
  }
  check('three round trips did not reload a', countOf('/a') === 1, String(countOf('/a')));
  check('three round trips did not reload b', countOf('/b') === 1, String(countOf('/b')));
  check('both pages are still alive', (await alive(a0.id)) && (await alive(b0.id)));

  process.stdout.write('\nexplicit refresh still reloads the page on screen\n');
  await activate('svc:machine:dsh.a.netbird');
  await page.evaluate(() => window.anywhere.refresh());
  await sleep(900);
  check('refresh reloaded the page', countOf('/a') === 2, String(countOf('/a')));
  const a2 = await viewOf();
  check('refresh kept the page identity', a2 !== null && a2.id === a0.id, JSON.stringify(a2));

  process.stdout.write('\nclosing a tab destroys its page\n');
  await page.click('.tab[data-tab-id="svc:machine:dsh.a.netbird"] .tab-close');
  await sleep(900);
  check('the closed page was destroyed', (await alive(a0.id)) === false);
  check('the other tab kept its page', await alive(b0.id));

  // The one command that replaces a wedged page is a control, not only a menu item: a
  // person who does not know the shortcut still has to find it on screen. This runs
  // last because it moves the pointer and replaces the page it is looking at.
  process.stdout.write('\nthe refresh control is on screen and reachable\n');
  await activate('svc:machine:dsh.b.netbird');
  const control = await page.evaluate(() => {
    const button = document.getElementById('refresh');
    const style = button ? getComputedStyle(button) : null;
    return {
      present: Boolean(button),
      visible: Boolean(button) && !button.hidden && style.display !== 'none' && style.visibility !== 'hidden',
      disabled: button ? button.disabled : true,
    };
  });
  check('the refresh control is present', control.present, true);
  check('the refresh control is visible', control.visible, true);
  check('the refresh control is enabled on a live page', control.disabled === false, String(control.disabled));

  process.stdout.write('\nthe control is the command, and it reloads the page on screen\n');
  const stripBefore = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tab')].map((tab) => tab.dataset.tabId),
    active: document.querySelector('.tab[data-active="true"]')?.dataset.tabId ?? null,
  }));
  await page.click('#refresh');
  await sleep(900);
  check('the control reloaded the page', countOf('/b') === 2, String(countOf('/b')));
  const b1 = await viewOf();
  check('refresh kept the page identity', b1 !== null && b1.id === b0.id, JSON.stringify(b1));
  // Refreshing a page is not a reason to rebuild the strip around it, and the reading a
  // refresh returns must not replace the window's own tab state.
  const stripAfter = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tab')].map((tab) => tab.dataset.tabId),
    active: document.querySelector('.tab[data-active="true"]')?.dataset.tabId ?? null,
  }));
  check('the strip is unchanged by a refresh', JSON.stringify(stripAfter), JSON.stringify(stripBefore));
  check('the active tab survives a refresh', stripAfter.active, 'svc:machine:dsh.b.netbird');

  process.stdout.write('\nthe keyboard asks for the same command\n');
  // Focus is where a shortcut is pressed from here: this document's keydown, and the
  // page behind a native view is the other layer that gets its own keystrokes.
  await page.evaluate(() => document.getElementById('refresh').focus());
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+R' : 'Control+R');
  await sleep(900);
  check('the shortcut reloaded the page once', countOf('/b') === 3, String(countOf('/b')));
  const b2 = await viewOf();
  check('the shortcut kept the page identity', b2 !== null && b2.id === b0.id, JSON.stringify(b2));

  await page.screenshot({ path: join(args.out, 'tab-strip.png') });
} finally {
  stderrLog.end();
  await app.close();
  site.close();
}

const outcome = failures === 0 ? 'all checks passed' : `${failures} check(s) failed`;
process.stdout.write(`\n${outcome} (evidence: ${args.out})\n`);
process.exit(failures === 0 ? 0 : 1);
