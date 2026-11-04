#!/usr/bin/env node
/**
 * Two networks, one window: public pages and overlay pages both open here.
 *
 * The desktop client is a browser for the machine's own network *and* the fleet's private
 * one. One Chromium session has one proxy setting, so the choice is made per request by
 * the PAC script `src/proxy-pac.mjs` generates: overlay names go to the agent's loopback
 * proxy, everything else goes direct. The contract this run asserts:
 *
 *   1. A machine's page loads through the agent proxy (that is the overlay half).
 *   2. A sign-in flow that redirects through a public identity provider, and comes back
 *      to the machine, completes inside the same tab - the case that used to load as a
 *      page error when public traffic was forbidden.
 *   3. A public link with `target=_blank` becomes a tab in this window, loaded directly
 *      rather than through the agent.
 *   4. A public link without `target` navigates in place, like any browser.
 *   5. A link whose scheme another application owns (`mailto:`) is handed to the platform.
 *   6. The tab strip comes back after a restart.
 *
 * Everything is served locally: the "overlay" is a stub agent proxy that forwards the
 * requests a real one would resolve, and the "public" hosts are pointed at the fixture by
 * Chromium's own resolver rules, so the only thing being tested is *which way* a request
 * went - the stub proxy's log is the overlay half, the fixture's log is the direct half.
 *
 * Usage:
 *   node poc/public-and-overlay.mjs --electron <path> [--out <dir>] [--packaged]
 *
 * `--electron` is the Electron executable of the runtime this package is verified against
 * (or `AW_ELECTRON`). The repository does not vendor Electron.
 */

import { createServer, request as httpRequest } from 'node:http';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = join(HERE, '..', 'shell');

function parseArgs(argv) {
  const args = { electron: process.env.AW_ELECTRON ?? '', out: join(HERE, 'evidence', 'public-and-overlay'), packaged: false };
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

/** Every page the fixture served, as `<Host> <path>`: the direct half of the evidence. */
const served = [];
/** Every request the stub agent proxy forwarded: the overlay half of the evidence. */
const proxied = [];

const fixture = createServer((request, response) => {
  const path = String(request.url ?? '/').split('?')[0];
  served.push(`${request.headers.host ?? ''} ${path}`);
  const html = (body) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><meta charset="utf-8"><title>page ${path}</title><body style="font:14px -apple-system">${body}</body>`);
  };
  if (path === '/a') {
    html(`<h1>machine a</h1>
<a id="sso" href="/sso">登录</a>
<a id="public-link" href="http://public.test:${fixturePort}/report" target="_blank">a public report</a>
<a id="public-nav" href="http://public.test:${fixturePort}/other">a public page in this tab</a>
<a id="mail" href="mailto:someone@example.com">mail someone</a>`);
    return;
  }
  if (path === '/sso') {
    // The first hop of a sign-in flow: the machine's page redirects to the provider.
    response.writeHead(302, { location: `http://auth.public.test:${fixturePort}/login?app=machine-a` });
    response.end();
    return;
  }
  if (path === '/login') {
    // The provider, once signed in, returns to the machine.
    response.writeHead(302, { location: 'http://dsh.a.netbird/after' });
    response.end();
    return;
  }
  if (path === '/after') {
    html('<h1>signed in</h1><p>the flow came back to the machine</p>');
    return;
  }
  html(`<h1>${path}</h1><p>a page a person would be reading</p>`);
});
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const fixturePort = fixture.address().port;

/**
 * The stub agent proxy: speaks the dialect the engine's loopback proxy does (the browser
 * sends an absolute-form target), resolves nothing, and forwards to the fixture. What
 * matters for the contract is which requests arrive here at all.
 */
const agentProxy = createServer((request, response) => {
  let target;
  try {
    target = new URL(String(request.url ?? ''));
  } catch {
    response.writeHead(400).end('bad target\n');
    return;
  }
  proxied.push(`${target.host} ${target.pathname}`);
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: fixturePort,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...request.headers, host: target.host },
    },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on('error', () => {
    if (!response.headersSent) {
      response.writeHead(502);
    }
    response.end('agent proxy upstream failed\n');
  });
  request.pipe(upstream);
});
agentProxy.on('connect', (request, socket) => {
  proxied.push(`CONNECT ${request.url}`);
  socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
});
await new Promise((resolve) => agentProxy.listen(0, '127.0.0.1', resolve));
const agentProxyUrl = `http://127.0.0.1:${agentProxy.address().port}`;

const ENGINE = { protocol: 1, helper: '0.1.1', netbird: 'v0.78.1' };
const KERNEL = { installed: true, version: '0.2.0-rc.2', reachable: true, service: { label: 'org.dsh.web', loaded: true } };
const states = {
  ready: {
    // The agent's proxy is what the overlay half of the client rides on; with it applied,
    // the PAC script sends overlay names here and everything else direct.
    proxy: agentProxyUrl,
    local: { state: 'ready', detail: '', machine: 'studio-mac', host: 'dsh.a.netbird', url: 'http://dsh.a.netbird/a' },
    fleet: { state: 'ready', detail: 'fleet ready' },
    engine: ENGINE,
    self: { machine: 'studio-mac', ip: '100.64.1.10', interfaceType: 'Userspace', host: 'dsh.a.netbird' },
    kernel: KERNEL,
    registered: 1,
    app: { version: '0.7.1', build: '1' },
    server: { line: 'netbird.example.com', hasUrl: true },
    entries: [
      { host: 'dsh.a.netbird', machine: 'studio-mac', ip: '100.64.1.10', url: 'http://dsh.a.netbird/a', statusCode: 200, local: true },
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * The resolver rules are how a test names a "public" host: Chromium resolves it to the
 * fixture, while the proxy decision still sees the canonical name. The overlay name is
 * mapped too, so the machine page itself needs no real fleet.
 */
const HOST_RULES = 'MAP dsh.a.netbird 127.0.0.1,MAP public.test 127.0.0.1,MAP auth.public.test 127.0.0.1';

const launchArgs = (withLog) => [
  `--user-data-dir=${userData}`,
  `--host-resolver-rules=${HOST_RULES}`,
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
  ...(withLog
    ? [
        // The acceptance seam: a hand-off is recorded rather than opening another
        // application on whoever is running the check.
        '--external-log',
        externalLog,
      ]
    : []),
];

const app = await electron.launch({ executablePath: args.electron, args: launchArgs(true) });

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
      : { id: view.webContents.id, url: view.webContents.getURL() };
  });
  const tabIds = () => page.evaluate(() => Array.from(document.querySelectorAll('.tab')).map((button) => button.dataset.tabId));
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const activate = async (id) => {
    await page.click(`.tab[data-tab-id="${id}"]`);
    await sleep(700);
  };
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
  const pageText = () => app.evaluate(async ({ webContents }) => {
    const view = globalThis.__awWorkspace;
    return view ? String(await view.webContents.executeJavaScript('document.body.textContent')) : '';
  });

  process.stdout.write('\nthe machine page loads through the agent\n');
  await page.click('.card[data-service-id="machine:dsh.a.netbird"]');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length >= 2, null, { timeout: 15_000 });
  await sleep(900);
  check('the page came up', (await viewOf())?.url === 'http://dsh.a.netbird/a', JSON.stringify(await viewOf()));
  check('the request went through the agent proxy', proxied.includes('dsh.a.netbird /a'), JSON.stringify(proxied));
  check('one window, as always', (await windowCount()) === 1, String(await windowCount()));

  process.stdout.write('\na sign-in flow through a public identity provider completes in the tab\n');
  await clickInPage('#sso');
  let afterSso = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250);
    afterSso = await viewOf();
    if (afterSso !== null && afterSso.url === 'http://dsh.a.netbird/after') {
      break;
    }
  }
  check('the flow came back to the machine', afterSso !== null && afterSso.url === 'http://dsh.a.netbird/after', JSON.stringify(afterSso));
  check(
    'the provider was reached directly, not through the agent',
    served.some((line) => line.startsWith('auth.public.test') && line.endsWith(' /login')) &&
      !proxied.some((line) => line.startsWith('auth.public.test')),
    JSON.stringify({ provider: served.filter((line) => line.startsWith('auth.public.test')), proxied }),
  );
  check('the signed-in page is the one in the tab', String(await pageText()).includes('signed in'), String(await pageText()).slice(0, 80));

  /** Back to the machine's front door, where the fixture's links live. */
  const frontDoor = async () => {
    await app.evaluate(async () => {
      const view = globalThis.__awWorkspace;
      await view.webContents.loadURL('http://dsh.a.netbird/a');
    });
    await sleep(900);
  };

  process.stdout.write('\na public link opens as a tab, directly\n');
  // The sign-in flow landed on its own "signed in" page, which is where a person would
  // be; the links below live on the front door.
  await frontDoor();
  await clickInPage('#public-link');
  await sleep(1000);
  const afterPublicLink = await tabIds();
  check('no second window was created', (await windowCount()) === 1, String(await windowCount()));
  check(
    'the link became a tab',
    afterPublicLink.includes(`link:http://public.test:${fixturePort}/report`),
    JSON.stringify(afterPublicLink),
  );
  check(
    'the public page loaded directly',
    served.some((line) => line.startsWith('public.test') && line.endsWith(' /report')),
    JSON.stringify(served.filter((line) => line.startsWith('public.test'))),
  );
  check('the public page did not go through the agent', !proxied.some((line) => line.startsWith('public.test')), JSON.stringify(proxied));

  process.stdout.write('\na public link without a target navigates in this tab\n');
  await activate('svc:machine:dsh.a.netbird');
  await clickInPage('#public-nav');
  await sleep(1000);
  const afterNav = await viewOf();
  check('the page on screen is the public one', afterNav !== null && afterNav.url === `http://public.test:${fixturePort}/other`, JSON.stringify(afterNav));
  check('no tab was added', (await tabIds()).length === afterPublicLink.length, JSON.stringify(await tabIds()));

  process.stdout.write('\na scheme another application owns is handed over\n');
  await activate('svc:machine:dsh.a.netbird');
  await frontDoor();
  await clickInPage('#mail');
  await sleep(700);
  check('the hand-off was recorded', handedOver().includes('mailto:someone@example.com'), JSON.stringify(handedOver()));
  check('the page on screen was kept', (await viewOf())?.url === 'http://dsh.a.netbird/a', JSON.stringify(await viewOf()));
  check('no web address was handed to another application', handedOver().every((url) => url.startsWith('mailto:')), JSON.stringify(handedOver()));

  await page.screenshot({ path: join(args.out, 'tab-strip.png') });
} finally {
  stderrLog.end();
  await app.close();
}

process.stdout.write('\na restart brings the link tab back\n');
const relaunch = await electron.launch({ executablePath: args.electron, args: launchArgs(false) });
try {
  const page = await relaunch.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => window.anywhere.refresh('ready'));
  await page.waitForFunction(() => document.querySelectorAll('.tab').length >= 3, null, { timeout: 15_000 });
  const restored = await page.evaluate(() => Array.from(document.querySelectorAll('.tab')).map((button) => button.dataset.tabId));
  check('the public link tab came back', restored.includes(`link:http://public.test:${fixturePort}/report`), JSON.stringify(restored));
  check('the machine tab came back', restored.includes('svc:machine:dsh.a.netbird'), JSON.stringify(restored));
  await page.screenshot({ path: join(args.out, 'tab-strip-restored.png') });
} finally {
  await relaunch.close();
  fixture.close();
  agentProxy.close();
}

const outcome = failures === 0 ? 'all checks passed' : `${failures} check(s) failed`;
process.stdout.write(`\n${outcome} (evidence: ${args.out})\n`);
if (existsSync(join(args.out, 'external-open.log'))) {
  process.stdout.write(`handed to the platform:\n${handedOver().map((url) => `  ${url}\n`).join('')}`);
}
process.stdout.write(`through the agent: ${proxied.join(', ') || '(none)'}\n`);
process.exit(failures === 0 ? 0 : 1);