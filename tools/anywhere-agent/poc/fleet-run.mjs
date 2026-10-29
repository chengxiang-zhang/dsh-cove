#!/usr/bin/env node
/**
 * The real multi-machine run: the app-scoped overlay, a stored identity, the fleet.
 *
 * The interface check proves what the list looks like; this run proves where the list
 * comes from. It launches the client the way a user's app launches, asks it for the
 * private network (`--fleet`, which is exactly the button a user presses), and asserts
 * that more than one machine is reachable - the claim that "your other machines appear
 * once you sign in" rests on.
 *
 * About the identity: the engine keeps an enrolled identity beside the app's data, so a
 * machine that has signed in before does not need a browser again. This run copies that
 * config into its own state directory, drives the app against the copy, and deletes the
 * copy afterwards - so the run never touches the live profile and leaves no key behind.
 * The management endpoint travels the same way: read from that config and passed in the
 * environment (`AW_MANAGEMENT_URL`, the variable the fleet installer already uses), so
 * no real endpoint is written into the repository.
 *
 * What it does touch: the private network. The app-scoped engine dials the management
 * server and holds an overlay as long as the app runs, which stops when the app quits.
 * That is the product's own behaviour, and it is why this is a deliberate, documented
 * run rather than something a check does on every commit.
 *
 * Usage:
 *   node poc/fleet-run.mjs [--out <dir>] [--identity <config.json>] [--timeout-ms 240000]
 */

import { _electron as electron } from 'playwright';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = join(HERE, '..', 'shell');
/** Where a signed-in app keeps the engine's identity, beside its own state. */
const DEFAULT_IDENTITY = join(homedir(), 'Library', 'Application Support', 'anywhere-shell', 'config.json');

/**
 * The management endpoint out of an engine config.
 *
 * The engine writes a Go `url.URL` as JSON, so the endpoint is the scheme and host of the
 * stored object rather than one string; anything unreadable means "no override", and the
 * shell's own default applies.
 *
 * @param {string} file the identity file to read
 * @returns {string} the endpoint, or '' when the config does not carry one
 */
function managementUrlOf(file) {
  try {
    const config = JSON.parse(readFileSync(file, 'utf8'));
    const url = config?.ManagementURL;
    const scheme = typeof url?.Scheme === 'string' ? url.Scheme : '';
    const host = typeof url?.Host === 'string' ? url.Host : '';
    return scheme === '' || host === '' ? '' : `${scheme}://${host}`;
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const args = {
    electron: process.env.AW_ELECTRON ?? '',
    out: join(HERE, 'evidence'),
    identity: DEFAULT_IDENTITY,
    timeoutMs: 240_000,
    // The machine's own engine, for a run that needs no overlay of its own.
    netbird: '',
    // Seconds to wait for a human to finish a sign-in, and 0 to assert the identity alone.
    awaitLoginMs: 0,
  };
  const values = {
    '--electron': 'electron',
    '--out': 'out',
    '--identity': 'identity',
    '--timeout-ms': 'timeoutMs',
    '--netbird': 'netbird',
    '--await-login-seconds': 'awaitLoginMs',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = values[argv[i]];
    if (key === undefined) continue;
    const raw = argv[i + 1];
    if (key === 'awaitLoginMs') args[key] = Number(raw) * 1_000;
    else if (key === 'timeoutMs') args[key] = Number(raw);
    else args[key] = raw;
    i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const stateDir = join(args.out, 'fleet-run');
const identityFile = join(stateDir, 'config.json');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures += 1;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}\n`);
}

let app = null;
try {
  const ownEngine = args.netbird !== '';
  if (!ownEngine && !existsSync(args.identity)) {
    process.stdout.write(`no stored identity at ${args.identity}\n`);
    process.stdout.write('this run needs a machine that has signed in before; a fresh machine needs the browser hand-off.\n');
    process.exit(2);
  }
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  let managementUrl = '';
  if (!ownEngine) {
    // The copy is what makes the run independent of the live profile: the app reads its
    // config from `--dir`, and it is deleted in the finally block below.
    copyFileSync(args.identity, identityFile);
    managementUrl = managementUrlOf(identityFile);
    process.stdout.write(`management endpoint from the stored config: ${managementUrl === '' ? '(none)' : 'present'}\n`);
  }

  app = await electron.launch({
    executablePath: args.electron,
    // The endpoint is supplied by the environment, never by the repository.
    env: managementUrl === '' ? process.env : { ...process.env, AW_MANAGEMENT_URL: managementUrl },
    args: [
      `--user-data-dir=${join(stateDir, 'chromium')}`,
      '--no-sandbox',
      '--disable-gpu',
      SHELL_DIR,
      // Two ways to reach a fleet, both real: the app's own overlay (the product path,
      // which is what the account chip starts), or the machine's own engine, which a
      // machine already inside the network is running anyway.
      ...(ownEngine ? ['--netbird', args.netbird] : ['--engine', '--fleet']),
      '--dir',
      stateDir,
    ],
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const snapshot = () => app.evaluate(() => globalThis.__awSnapshot ?? null);

  const settledStates = ['ready', 'empty', 'error', 'login-required'];
  const deadline = Date.now() + args.timeoutMs;
  let settled = await snapshot();
  while (Date.now() < deadline && !settledStates.includes(settled?.state)) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    settled = await snapshot();
  }
  process.stdout.write(`main process: ${JSON.stringify({ state: settled?.state, entries: settled?.entries, registered: settled?.registered })}\n`);

  if (settled?.state === 'login-required' && args.awaitLoginMs > 0) {
    // The product's own hand-off, minted the way the button mints it: short-lived, and
    // handed to a person rather than written down.
    const fresh = await page.evaluate(() => window.anywhere.freshLogin());
    process.stdout.write(`LOGIN_URL=${fresh?.url ?? ''}\n`);
    process.stdout.write(`waiting up to ${args.awaitLoginMs / 1000}s for the sign-in to finish in a browser...\n`);
    const loginDeadline = Date.now() + args.awaitLoginMs;
    while (Date.now() < loginDeadline && settled?.state !== 'ready') {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      settled = await snapshot();
    }
  }

  check('the fleet link comes up', settled?.state, 'ready');
  if (settled?.state !== 'ready') {
    const detail = await page.locator('#state-body').innerText().catch(() => '?');
    process.stdout.write(`  panel says: ${JSON.stringify(detail)}\n`);
    throw new Error(`the run cannot assert a machine list in state ${settled?.state}`);
  }

  // The claim under test: after signing in there is more than this machine.
  check('more than one machine is reachable', (settled?.entries ?? 0) > 1, true);
  process.stdout.write(`  machines: ${settled?.entries} (registered ${settled?.registered})\n`);

  await page.waitForFunction(() => document.getElementById('status-label')?.innerText === '已连接', null, { timeout: 20_000 });
  check('status line reports the fleet', await page.locator('#status-label').innerText(), '已连接');
  // The grouping is conditional on knowing which row is this machine. The app's own link
  // knows (the fleet publishes a record for every machine, this one included), so the list
  // splits into 本机 and 其他机器. A machine's own engine, by contrast, never lists itself
  // as a peer - so in that mode there is no self row to group, and the honest reading is a
  // single section. Both are asserted rather than assumed.
  const groupTitles = (await page.locator('.group-title').allInnerTexts()).join('|');
  check('group titles', groupTitles, ownEngine ? '其他机器' : '本机|其他机器');
  const rows = page.locator('#groups .machine');
  const total = await rows.count();
  check('every reachable machine has a row', total, settled?.entries);
  const others = await page.locator('#groups .machine[data-local="false"]').count();
  check('at least one row is another machine', others > 0, true);
  process.stdout.write(`  rows: ${total} (this machine ${total - others}, others ${others})\n`);
  // The badge is data, not decoration: report how many rows the fleet says have finished
  // work, without asserting a number that changes with other people's sessions.
  const badged = await page.locator('#groups .machine[data-unread="true"]').count();
  process.stdout.write(`  rows reporting finished work: ${badged}\n`);

  // Entering another machine is the whole point of the fleet, and the seam is how a
  // native view can be shown to have opened.
  const remote = page.locator('#groups .machine[data-local="false"]').first();
  const remoteHost = await remote.getAttribute('data-host');
  await remote.click();
  const openDeadline = Date.now() + 60_000;
  let workspace = null;
  while (Date.now() < openDeadline && workspace === null) {
    workspace = (await snapshot())?.workspace ?? null;
    if (workspace === null) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  check('another machine opens in the pane', workspace?.host, remoteHost);
  process.stdout.write(`workspace seam: ${JSON.stringify(workspace)}\n`);
  await page.screenshot({ path: join(args.out, 'shell-fleet-run.png') });
  process.stdout.write(`screenshot: ${join(args.out, 'shell-fleet-run.png')}\n`);
} catch (error) {
  failures += 1;
  process.stdout.write(`run failed: ${error?.message ?? error}\n`);
} finally {
  // The identity copy is not evidence and must not outlive the run.
  rmSync(identityFile, { force: true });
  rmSync(join(stateDir, 'state.json'), { force: true });
  writeFileSync(join(stateDir, '.gitkeep'), '');
  if (app !== null) {
    await app.close().catch(() => undefined);
  }
}

process.stdout.write(failures === 0 ? 'RESULT pass\n' : `RESULT fail (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);