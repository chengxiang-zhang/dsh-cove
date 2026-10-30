#!/usr/bin/env node
/**
 * The agent contract, end to end: claim a tab, show it, drive it, let go.
 *
 * This is the piece the interface alone cannot prove. An agent gets no scripting hole of
 * its own; it reads a file for the port and token, asks which tabs exist, claims one, and
 * the window has to say so on screen. Then it releases, and the window has to stop saying
 * it.
 *
 * The page itself is driven over CDP - the same protocol the sidebar's session browser
 * uses - because that is the honest shape of "the agent works in the tab": it is a browser
 * client, not an API inside the app.
 *
 * Usage: node poc/agent-bridge.mjs [--electron <path>] [--out <dir>]
 */

import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = join(HERE, '..', 'shell');

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

// A page the agent can read without any network: what matters is that it is a real page in
// a real tab, not where it came from.
const site = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><meta charset="utf-8"><title>财报面板</title><h1 id="title">季度财报</h1><p id="rows">三张表</p>');
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const SITE_URL = `http://127.0.0.1:${site.address().port}/`;

const stateDir = join(args.out, 'agent-bridge');
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });
writeFileSync(
  join(args.out, 'agent-bridge.services.json'),
  JSON.stringify({ services: [{ id: 'web:finance', name: '财报面板', subtitle: '季度', url: SITE_URL }] }, null, 2),
  'utf8',
);

const entry = (machine, statusCode) => ({ host: `dsh.${machine}.netbird`, machine, ip: '100.64.1.10', url: SITE_URL, statusCode });
const snapshots = {
  ready: {
    local: { state: 'ready', detail: '', machine: 'studio-mac', host: 'dsh.studio-mac.netbird', url: SITE_URL },
    fleet: { state: 'ready', detail: '' },
    engine: { protocol: 1, helper: '0.1.1', netbird: 'v0.78.1' },
    self: { machine: 'studio-mac', ip: '100.64.1.10', interfaceType: 'Userspace', host: 'dsh.studio-mac.netbird' },
    kernel: { installed: true, version: '0.2.0-rc.2', reachable: true },
    registered: 2,
    app: { version: '0.4.10', build: '118' },
    server: { line: 'netbird.example.com', hasUrl: true },
    entries: [{ ...entry('studio-mac', 200), local: true }, entry('tower-lab', 200)],
  },
};
const statesFile = join(args.out, 'agent-bridge.states.json');
writeFileSync(statesFile, JSON.stringify(snapshots, null, 2), 'utf8');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    process.stdout.write(`  FAIL ${name}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}\n`);
  } else {
    process.stdout.write(`  ok   ${name}\n`);
  }
}

const app = await electron.launch({
  executablePath: args.electron,
  args: [
    `--user-data-dir=${join(stateDir, 'chromium')}`,
    '--no-sandbox',
    '--disable-gpu',
    // The window has to be a CDP target for a client to drive the page inside it.
    '--remote-debugging-port=0',
    SHELL_DIR,
    '--states',
    statesFile,
    '--services',
    join(args.out, 'agent-bridge.services.json'),
    '--agent-port',
    '0',
    '--dir',
    stateDir,
  ],
  colorScheme: 'light',
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => window.anywhere.refresh('ready'));
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 1, null, { timeout: 20_000 });

  // The agent's first step is the file: port and token, never printed.
  let bridge = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      bridge = JSON.parse(readFileSync(join(stateDir, 'agent-bridge.json'), 'utf8'));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  check('the window published where to reach it', bridge !== null, true);
  process.stdout.write(`  bridge: ${bridge?.url}\n`);

  const call = async (path, body, token = bridge.token) => {
    const response = await fetch(`${bridge.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  // Without the token, nothing. The window is not a public remote control.
  check('a client without the token is refused', (await call('/state', undefined, 'wrong')).status, 401);

  // A tab the agent can drive: open the web service the way a person would.
  await page.click('.card[data-service-id="web:finance"]');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 2, null, { timeout: 20_000 });
  await page.waitForTimeout(800);
  const state = await call('/state');
  check('the agent can see the tabs', state.body.tabs.length, 2);
  const tab = state.body.tabs.find((candidate) => candidate.serviceId === 'web:finance');
  check('the new tab is listed with its title', Boolean(tab?.title), true);
  check('nothing is claimed yet', tab?.agent, null);

  // Claim it read-only: the window has to say so.
  const claimed = await call('/claim', { tabId: tab.id, by: 'poc-agent', tier: 'read-only' });
  check('the claim is accepted', claimed.status, 200);
  check('the tier is read-only by default', claimed.body.claim.tier, 'read-only');
  await page.waitForTimeout(600);
  check('the tab wears the A badge', await page.locator('.tab-agent').count(), 1);
  check('the operating bar is on screen', await page.locator('#agent-bar').isVisible(), true);
  check('the bar says what the agent may do', await page.locator('#agent-tier').innerText(), '只读');
  check('the bar names the tab it is driving', /财报面板/.test(await page.locator('#agent-text').innerText()), true);

  const claimedAgain = await call('/claim', { tabId: tab.id, by: 'someone-else' });
  check('a second agent cannot take the same tab', claimedAgain.status, 409);

  // A client drives the page, and the way it does that is CDP. Chromium writes the port it
  // chose into the profile, so the check can look for the tab the claim named.
  let devtoolsPort = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      devtoolsPort = Number(readFileSync(join(stateDir, 'chromium', 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      if (devtoolsPort > 0) {
        break;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json();
  const pageTargets = targets.filter((target) => target.type === 'page');
  process.stdout.write(`  cdp targets: ${pageTargets.map((target) => target.url).join(' | ')}\n`);
  check('the claimed page is a CDP target', pageTargets.some((target) => target.url.startsWith(SITE_URL)), true);

  // The page under the claim is a real page: read it from the process that owns it.
  const title = await app.evaluate(async () => {
    const view = globalThis.__awWorkspace;
    if (!view) {
      return '';
    }
    return view.webContents.getTitle();
  });
  check('the page under the claim is the real one', title, '财报面板');

  // Letting go is what makes the badge disappear; a claim that outlives its agent would
  // leave a window that looks busy forever.
  const released = await call('/release', { tabId: tab.id, by: 'poc-agent' });
  check('the release is accepted', released.body.released, true);
  await page.waitForTimeout(600);
  check('the badge is gone', await page.locator('.tab-agent').count(), 0);
  check('the bar is gone', await page.locator('#agent-bar').isHidden(), true);

  await page.screenshot({ path: join(args.out, 'agent-bridge.png') });
  process.stdout.write(`screenshot: ${join(args.out, 'agent-bridge.png')}\n`);
} finally {
  await app.close();
  site.close();
}

process.stdout.write(failures === 0 ? '\nagent-bridge: all checks passed\n' : `\nagent-bridge: ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
