#!/usr/bin/env node
/**
 * Link routing: which links stay in this window and which leave for the platform browser.
 *
 * The window's only network is the overlay. Its session proxy dials through NetBird's
 * userspace stack, which carries the fleet and nothing else, so a public address inside
 * this window cannot load at all: it fails as a page error, which reads as "the link is
 * broken" rather than "that link belongs to the system browser". The contract this run
 * asserts:
 *
 *   1. A link to an overlay address (same machine, another machine, the fleet zone) opens
 *      as a new tab in this window and creates no second window.
 *   2. A link to a public address is handed to the platform browser and never loaded here:
 *      no tab, no window, the page on screen unchanged.
 *   3. The same holds for a plain navigation (no target=_blank): the page on screen is not
 *      replaced by a public address it cannot load.
 *
 * The pages are served locally, so the run dials no network. The hand-off is recorded in a
 * file (`--external-log`, an acceptance seam) instead of opening a browser on the
 * operator's desktop; the recorded lines are what "handed over" means here.
 *
 * Usage:
 *   node poc/link-routing.mjs --electron <path> [--out <dir>] [--packaged]
 *
 * `--electron` is the Electron executable of the runtime this package is verified against
 * (or `AW_ELECTRON`). The repository does not vendor Electron.
 */

import { createServer } from 'node:http';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = join(HERE, '..', 'shell');

function parseArgs(argv) {
  const args = { electron: process.env.AW_ELECTRON ?? '', out: join(HERE, 'evidence', 'link-routing'), packaged: false };
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
rmSync(args.out, { recursive: true, force: true });
mkdirSync(args.out, { recursive: true });

/** One served document request per path, so "it loaded here" is a request the server saw. */
const loads = new Map();
/** Set once the port is known; the page's same-machine link is written from it. */
let base = '';
const site = createServer((request, response) => {
  const path = String(request.url ?? '/').split('?')[0];
  loads.set(path, (loads.get(path) ?? 0) + 1);
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (path === '/a') {
    response.end(`<!doctype html><meta charset="utf-8"><title>workspace a</title>
<body style="font:14px -apple-system">
<h1>workspace a</h1>
<a id="intranet" href="${base}/other" target="_blank">another page on this machine</a>
<a id="overlay" href="http://dsh.b.netbird/report" target="_blank">another machine</a>
<a id="public" href="http://public.invalid/report" target="_blank">a public report</a>
<a id="public-nav" href="http://news.invalid/x">a public page, no target</a>
</body>`);
    return;
  }
  response.end(`<!doctype html><meta charset="utf-8"><title>page ${path}</title>
<body style="font:14px -apple-system"><h1>${path}</h1><p>a page a person would be reading</p></body>`);
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${site.address().port}`;

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
      { host: 'dsh.a.netbird', machine: 'studio-mac', ip: '100.64.1.10', url: `${base}/a`, statusCode: 200, local: true },
      { host: 'dsh.b.netbird', machine: 'machine-b', ip: '100.64.1.11', url: `${base}/b`, statusCode: 200 },
    ],
  },
};
const statesFile = join(args.out, 'states.json');
writeFileSync(statesFile, JSON.stringify(states, null, 2), 'utf8');
const userData = join(args.out, 'userdata');
mkdirSync(userData, { recursive: true });
const servicesFile = join(args.out, 'services.json');
writeFileSync(servicesFile, JSON.stringify({ services: [] }, null, 2), 'utf8');
const externalLog = join(args.out, 'external-open.log');
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

/** Everything the platform browser was handed, in order. */
const handedOver = () => {
  try {
    return readFileSync(externalLog, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch {
    return [];
  }
};

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
    // The acceptance seam: a hand-off is recorded rather than opening a browser window
    // on whoever is running the check.
    '--external-log',
    externalLog,
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

  /** The page currently on screen (whichever tab owns the page area). */
  const viewOf = () => app.evaluate(() => {
    const view = globalThis.__awWorkspace;
    return view === null || view === undefined
      ? null
      : { id: view.webContents.id, url: view.webContents.getURL(), visible: view.getVisible() };
  });
  const tabIds = () => page.evaluate(() => Array.from(document.querySelectorAll('.tab')).map((button) => button.dataset.tabId));
  /**
   * The window's own windows, from the main process.
   *
   * Deliberately not `app.windows()`: the pages of this shell are `WebContentsView`s, and
   * Playwright reports those as windows too. A raw popup is a real `BrowserWindow`, so
   * that is what "no second window" has to count.
   */
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const activate = async (id) => {
    await page.click(`.tab[data-tab-id="${id}"]`);
    await sleep(700);
  };
  /** Clicks a link inside the page on screen, as a person would (a real user gesture). */
  const clickInPage = (selector) => app.evaluate(async ({ webContents }, target) => {
    const view = globalThis.__awWorkspace;
    if (view === null || view === undefined) {
      return { ok: false, reason: 'no page on screen' };
    }
    await view.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(target)}).click()`,
      true,
    );
    return { ok: true };
  }, selector);

  process.stdout.write('\nthe machine page is up\n');
  await page.click('.card[data-service-id="machine:dsh.a.netbird"]');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length >= 2, null, { timeout: 15_000 });
  await sleep(700);
  const first = await viewOf();
  check('machine a opened its page', first !== null && first.url === `${base}/a`, JSON.stringify(first));
  check('one window, as before', (await windowCount()) === 1, String(await windowCount()));

  process.stdout.write('\nan overlay link opens as a tab in this window\n');
  await clickInPage('#intranet');
  await sleep(900);
  const afterIntranet = await tabIds();
  const intranetView = await viewOf();
  check('no second window was created', (await windowCount()) === 1, String(await windowCount()));
  check('the link became a tab', afterIntranet.includes(`link:${base}/other`), JSON.stringify(afterIntranet));
  check('the page area shows the linked page', intranetView !== null && intranetView.url === `${base}/other`, JSON.stringify(intranetView));
  check('the linked page was requested once', countOf('/other') === 1, String(countOf('/other')));

  process.stdout.write('\na link to another machine stays in this window too\n');
  await activate('svc:machine:dsh.a.netbird');
  const tabsBeforeOverlay = await tabIds();
  await clickInPage('#overlay');
  await sleep(900);
  const afterOverlay = await tabIds();
  check('no second window was created', (await windowCount()) === 1, String(await windowCount()));
  check(
    'the fleet-zone link became a tab',
    afterOverlay.includes('link:http://dsh.b.netbird/report') && afterOverlay.length === tabsBeforeOverlay.length + 1,
    JSON.stringify(afterOverlay),
  );

  process.stdout.write('\na dead link tab stays a tab, with the error page and its retry\n');
  // The name does not resolve here, so the tab is on screen as a failure: retry must be
  // the user asking for that page again, through the one explicit-reload path.
  await page.waitForFunction(() => !document.getElementById('message')?.hidden, null, { timeout: 10_000 });
  await page.click('.message .button.primary');
  await sleep(900);
  check(
    'retry asked for that page through the explicit-reload path',
    readFileSync(join(args.out, 'app-stderr.log'), 'utf8').includes('reloading link:http://dsh.b.netbird/report for an explicit refresh'),
    'no explicit refresh of the link tab was logged',
  );
  check('the dead link is still one tab', (await tabIds()).includes('link:http://dsh.b.netbird/report'), JSON.stringify(await tabIds()));

  process.stdout.write('\na public link goes to the platform browser\n');
  await activate('svc:machine:dsh.a.netbird');
  const beforePublic = await tabIds();
  await clickInPage('#public');
  await sleep(900);
  const afterPublic = await tabIds();
  const publicView = await viewOf();
  check('no second window was created', (await windowCount()) === 1, String(await windowCount()));
  check('the public link did not become a tab', afterPublic.length === beforePublic.length, JSON.stringify(afterPublic));
  check('the hand-off was recorded', handedOver().includes('http://public.invalid/report'), JSON.stringify(handedOver()));
  check('the public page was never loaded here', publicView !== null && publicView.url === `${base}/a`, JSON.stringify(publicView));

  process.stdout.write('\na plain navigation to a public page does not replace the page on screen\n');
  const beforeNav = await tabIds();
  await clickInPage('#public-nav');
  await sleep(900);
  const afterNav = await tabIds();
  const navView = await viewOf();
  check('no second window was created', (await windowCount()) === 1, String(await windowCount()));
  check('no tab was added', afterNav.length === beforeNav.length, JSON.stringify(afterNav));
  check('the hand-off was recorded', handedOver().includes('http://news.invalid/x'), JSON.stringify(handedOver()));
  check('the page on screen was kept', navView !== null && navView.url === `${base}/a`, JSON.stringify(navView));

  await page.screenshot({ path: join(args.out, 'tab-strip.png') });
} finally {
  stderrLog.end();
  await app.close();
}

// The tab strip is what the next launch restores, so the run is closed with the same
// question a person asks the morning after: are the pages I followed still there?
process.stdout.write('\na restart brings the link tabs back, and only the link tabs\n');
const relaunch = await electron.launch({
  executablePath: args.electron,
  args: [
    `--user-data-dir=${userData}`,
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
  const page = await relaunch.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => window.anywhere.refresh('ready'));
  await page.waitForFunction(() => document.querySelectorAll('.tab').length >= 4, null, { timeout: 15_000 });
  const restored = await page.evaluate(() => Array.from(document.querySelectorAll('.tab')).map((button) => button.dataset.tabId));
  check('the page this machine linked to came back', restored.includes(`link:${base}/other`), JSON.stringify(restored));
  check('the other machine link came back too', restored.includes('link:http://dsh.b.netbird/report'), JSON.stringify(restored));
  check(
    'no public address is a tab, then or now',
    !restored.some((id) => id.includes('invalid')),
    JSON.stringify(restored),
  );
  await page.screenshot({ path: join(args.out, 'tab-strip-restored.png') });
} finally {
  await relaunch.close();
  site.close();
}

const outcome = failures === 0 ? 'all checks passed' : `${failures} check(s) failed`;
process.stdout.write(`\n${outcome} (evidence: ${args.out})\n`);
if (existsSync(join(args.out, 'external-open.log'))) {
  process.stdout.write(`handed to the platform browser:\n${handedOver().map((url) => `  ${url}\n`).join('')}`);
}
process.exit(failures === 0 ? 0 : 1);