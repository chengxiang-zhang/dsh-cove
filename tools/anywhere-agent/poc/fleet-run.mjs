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
    const detail = await page.locator('#banner-text').innerText().catch(() => '?');
    process.stdout.write(`  banner says: ${JSON.stringify(detail)}\n`);
    throw new Error(`the run cannot assert a machine list in state ${settled?.state}`);
  }

  // The claim under test: after signing in there is more than this machine.
  check('more than one machine is reachable', (settled?.entries ?? 0) > 1, true);
  process.stdout.write(`  machines: ${settled?.entries} (registered ${settled?.registered})\n`);

  // A connected fleet is a healthy window: the home, no banner, and no aggregation text.
  await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, null, { timeout: 20_000 });
  check('a connected fleet shows no banner', await page.locator('#banner').isHidden(), true);
  check(
    'the window still has no reachability aggregate',
    /台可达|已连接 ·/.test(await page.locator('body').innerText()),
    false,
  );

  // Every reachable machine is a card. The tab shell does not split 本机 / 其他机器 into
  // two groups the way the old three-column layout did: it is one list, and the machine
  // you are on says so in its own subtitle. That is the assertion now.
  const cards = page.locator('.card[data-service-id^="machine:"]');
  const total = await cards.count();
  check('every reachable machine is a card', total, settled?.entries);
  const localCards = await page.locator('.card[data-service-id^="machine:"] .card-flag').count();
  const remoteCards = total - localCards;
  process.stdout.write(`  cards: ${total} (this machine ${localCards}, others ${remoteCards})\n`);
  if (!ownEngine) {
    check('this machine is one of the cards', localCards, 1);
  }
  check('at least one card is another machine', remoteCards > 0, true);

  // The badge is data, not decoration: report how many cards the fleet says have finished
  // work, without asserting a number that changes with other people's sessions.
  const badged = await page.locator('.card-badge').count();
  process.stdout.write(`  cards reporting finished work: ${badged}\n`);

  // Entering another machine is the whole point of the fleet, and the seam is how a
  // native view can be shown to have opened.
  const remote = cards.filter({ hasNot: page.locator('.card-flag') }).first();
  const remoteId = await remote.getAttribute('data-service-id');
  const remoteHost = String(remoteId ?? '').replace(/^machine:/, '');
  await remote.click();
  const openDeadline = Date.now() + 60_000;
  let workspace = null;
  let tabs = 0;
  while (Date.now() < openDeadline) {
    workspace = (await snapshot())?.workspace ?? null;
    tabs = await page.locator('.tab').count();
    if (workspace !== null && tabs >= 2) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  check('another machine opens as a tab', tabs >= 2, true);
  check('the workspace seam names that machine', workspace?.host, remoteHost);
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