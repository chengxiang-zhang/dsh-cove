#!/usr/bin/env node
/**
 * The real first run, on this machine: no scripted state, no fixtures, no proxy.
 *
 * The interface check (`poc/shell-states.mjs`) proves what each state looks like. This
 * run proves the wiring underneath the two product rules that cannot be faked:
 *
 *   1. opening the app is enough on a machine that is already set up - the client reads
 *      the host and the runtime behind it and opens the workspace, and it installs
 *      nothing: a machine that is missing either gets the fleet installer's command for
 *      its own terminal instead;
 *   2. no account is needed to use the machine in front of you - the window settles on
 *      "本机可用", this machine's row is in the list, and the network is still off.
 *
 * It touches the machine only through the read path in every case (a port probe, a
 * runtime lookup, a version query): there is no branch of this run that writes,
 * installs or fetches anything.
 *
 * Usage:
 *   node poc/local-first-run.mjs [--out <dir>] [--electron <path>]
 */

import { _electron as electron } from 'playwright';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KERNEL_PORT, machineLabel, trustedHost } from '../agent/kernel.mjs';
import { badgeUrl, summarizeFeed } from '../src/notify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = join(HERE, '..', 'shell');

/**
 * Reads this machine's finished-run feed the way the shell does.
 *
 * The request is built by the client's own `badgeUrl` and reduced by its own
 * `summarizeFeed`, so the run compares the screen with the data path rather than with a
 * hand-written expectation. A host that does not answer is "nothing unseen", never an
 * error - the same rule the shell applies.
 *
 * @param {number} [since] the watermark to read from, which is what the badge measures from
 * @returns {Promise<object>} the summary the badge is derived from
 */
async function readLocalFeed(since = 0) {
  try {
    const response = await fetch(badgeUrl(`http://127.0.0.1:${KERNEL_PORT}/`, since), { signal: AbortSignal.timeout(4_000) });
    if (response.status !== 200) {
      return { unread: 0, latest: 0, note: `HTTP ${response.status}` };
    }
    return { ...summarizeFeed(await response.text(), since), note: 'ok' };
  } catch (error) {
    return { unread: 0, latest: 0, note: String(error?.message ?? error) };
  }
}

/**
 * The watermark file the shell keeps, written before launch.
 *
 * A client that has never read this host treats the host's history as a baseline rather
 * than as news, so a run that wants to see a number has to arrive as a client that has
 * been here before. The shell's own key for this machine is what is written, computed the
 * same way it computes it: the local identity with no fleet to answer for it.
 *
 * @param {string} dir the state directory the shell is launched with
 * @param {number} back how many of the newest notices to leave unread
 * @returns {Promise<{ watermark: number, latest: number }>} what was written
 */
async function seedWatermark(dir, back) {
  const latest = (await readLocalFeed(0)).latest;
  const watermark = Math.max(0, latest - back);
  const host = trustedHost(machineLabel(hostname()));
  writeFileSync(join(dir, 'notify.json'), `${JSON.stringify({ [host]: watermark }, null, 2)}\n`);
  return { watermark, latest };
}

function parseArgs(argv) {
  const args = {
    electron: process.env.AW_ELECTRON ?? '',
    out: join(HERE, 'evidence'),
    timeoutMs: 120_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--electron') args.electron = argv[i + 1];
    else if (argv[i] === '--out') args.out = argv[i + 1];
    else if (argv[i] === '--timeout-ms') args.timeoutMs = Number(argv[i + 1]);
    if (['--electron', '--out', '--timeout-ms'].includes(argv[i])) i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const stateDir = join(args.out, 'local-first-run');
// A run owns its state directory: a watermark left by the previous run would make this
// one start with a reading it did not take. What it does seed is a client that has read
// this host before, because a first contact is a baseline by design - the run has to
// arrive as a client that has been here, or there is no number to compare against.
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });
const seed = await seedWatermark(stateDir, 5);
process.stdout.write(`seeded watermark: ${JSON.stringify(seed)}\n`);

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures += 1;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}\n`);
}

const app = await electron.launch({
  executablePath: args.electron,
  args: [
    `--user-data-dir=${stateDir}`,
    // Development-run switches: the Chromium sandbox cannot initialise in the
    // restricted environment this often runs from. Not product behaviour.
    '--no-sandbox',
    '--disable-gpu',
    // No `--fleet`: the point of this run is that nothing about it needs an account.
    SHELL_DIR,
    '--engine',
    '--dir',
    stateDir,
  ],
});
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');

const snapshot = () => app.evaluate(() => globalThis.__awSnapshot ?? null);

const deadline = Date.now() + args.timeoutMs;
let settled = await snapshot();
while (Date.now() < deadline && !['local', 'ready', 'error'].includes(settled?.state)) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  settled = await snapshot();
}
process.stdout.write(`main process: ${JSON.stringify(settled)}\n`);

// The state the product promises a first run: this machine, no account.
check('the window settles on the local machine', settled?.state, 'local');
check('exactly this machine is listed', settled?.entries, 1);

const local = await app.evaluate(async () => {
  // The shell publishes its own blocks through the same seam as the state.
  const win = globalThis.__awSnapshot ?? {};
  return win;
});
check('the local half is what decided the state', typeof local.state === 'string', true);

// The first run's promise, in the tab shell: this machine as the only service, the home
// as the only tab, and nothing opened on the user's behalf.
await page.waitForFunction(() => document.querySelectorAll('.card').length > 0, null, { timeout: 20_000 });
check('the window opens on the home', await page.locator('#home').isVisible(), true);
check('one tab, and it is the home', await page.locator('.tab .tab-title').first().innerText(), '首页');
check('a healthy local state shows no banner', await page.locator('#banner').isHidden(), true);
check('exactly one machine is offered', await page.locator('.card[data-service-id^="machine:"]').count(), 1);
check(
  'the card of this machine carries the local flag',
  await page.locator('.card[data-service-id^="machine:"] .card-flag').first().innerText(),
  '本机',
);
check('no workspace was opened unasked', (await snapshot())?.workspace ?? null, null);

// The finished-run badge, against the host that is actually running. The count is
// computed by the client's own reader over the client's own request, so this compares the
// screen with the data path rather than with a fixture.
const summary = await readLocalFeed(seed.watermark);
process.stdout.write(`live feed: ${JSON.stringify(summary)}\n`);
const badge = page.locator('.card[data-service-id^="machine:"] .card-badge');
if (summary.unread > 0) {
  check('the badge shows what the host reports', await badge.first().innerText(), String(summary.unread));
} else {
  check('no badge when the host reports nothing', await badge.count(), 0);
}

// The other half of the same rule: a client that has never read this host must not claim
// its history as work to come back for. The store is removed to make this process exactly
// that client, and the refresh is what asks it to read again.
rmSync(join(stateDir, 'notify.json'), { force: true });
// The refresh is the client's own read, not a keyboard shortcut: the same call the
// toolbar and the menu make, so the check cannot pass because a shortcut happened to be
// wired differently.
await page.evaluate(() => window.anywhere.refresh());
let baselined = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    baselined = JSON.parse(readFileSync(join(stateDir, 'notify.json'), 'utf8'));
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
check('the baseline was written back', baselined !== null, true);
baselined = baselined ?? {};
const baselineWatermark = Object.values(baselined)[0] ?? 0;
check('the first read of a host is a baseline, not a badge', await badge.count(), 0);
check('and it establishes where seen starts', baselineWatermark, (await readLocalFeed(0)).latest);
process.stdout.write(`baseline watermark: ${baselineWatermark}\n`);

await page.screenshot({ path: join(args.out, 'shell-local-first-run.png') });
process.stdout.write(`screenshot: ${join(args.out, 'shell-local-first-run.png')}\n`);

// Opening the machine is a click on its service, and the workspace is a tab of its own.
await page.click('.card[data-service-id^="machine:"]');
await page.waitForFunction(() => document.querySelectorAll('.tab').length === 2, null, { timeout: 25_000 });
check('opening the machine adds one tab', await page.locator('.tab').count(), 2);
check('the home stepped aside', await page.locator('#home').isHidden(), true);
const opened = await snapshot();
check('the workspace seam names the machine', typeof opened?.workspace?.host === 'string', true);
process.stdout.write(`workspace seam: ${JSON.stringify(opened?.workspace ?? null)}\n`);
await page.screenshot({ path: join(args.out, 'shell-local-first-run-workspace.png') });

// Coming back: the machine you are inside is one you watched finish its work, so its row
// must not be carrying a count for what happened while you were in there.
await page.click('.tab[data-tab-id="home"]');
await page.waitForFunction(() => !document.getElementById('home')?.hidden, null, { timeout: 10_000 });
check('inside the machine, its own finished work is not a badge', await badge.count(), 0);

// The diagnostics that used to be scattered now live in the settings tab.
await page.click('#open-settings');
await page.waitForFunction(() => !document.getElementById('settings')?.hidden, null, { timeout: 10_000 });
const rows = await page.locator('#settings .row .value').allInnerTexts();
process.stdout.write(`settings facts: ${JSON.stringify(rows)}\n`);
check('the settings page carries the diagnostics', rows.length > 3, true);
check('the host reports itself', rows.some((line) => /常驻|外部托管/.test(line)), true);

await app.close();
process.stdout.write(failures === 0 ? 'RESULT pass\n' : `RESULT fail (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);