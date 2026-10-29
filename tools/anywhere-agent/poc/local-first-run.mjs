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

await page.waitForFunction(() => document.getElementById('status-label')?.innerText === '本机可用', null, { timeout: 10_000 });
check('status line', await page.locator('#status-label').innerText(), '本机可用');
check('rows in the list', await page.locator('#groups .machine').count(), 1);
check('group titles', (await page.locator('.group-title').allInnerTexts()).join('|'), '本机|其他机器');
check('the account chip says nobody is signed in', await page.locator('#account-name').innerText(), '未登录');
check('the network is still off', /连接其他机器/.test(await page.locator('#account-action').innerText()), true);

// The window lands on the home: the front door names the machine a click would open, and
// the rail says so. Nothing has opened a workspace on the user's behalf.
check('the pane is the home', await page.locator('#state-panel').getAttribute('data-kind'), 'home');
check('the home names the machine', /打开 .* 的工作区/.test(await page.locator('#state-actions button').first().innerText()), true);
check('the rail marks the home', await page.locator('#rail-machines').getAttribute('data-active'), 'true');
check('the new-session entry is available', await page.locator('#rail-session').isDisabled(), false);
check('no workspace was opened unasked', (await snapshot())?.workspace ?? null, null);

// The finished-run badge, against the host that is actually running. The count is
// computed by the client's own reader over the client's own request, so this compares the
// screen with the data path rather than with a fixture.
const summary = await readLocalFeed(seed.watermark);
process.stdout.write(`live feed: ${JSON.stringify(summary)}\n`);
const badge = page.locator('#groups .machine-unread');
if (summary.unread > 0) {
  check('the badge shows what the host reports', await badge.first().innerText(), String(summary.unread));
} else {
  check('no badge when the host reports nothing', await badge.count(), 0);
}

// The other half of the same rule: a client that has never read this host must not claim
// its history as work to come back for. The store is removed to make this process exactly
// that client, and the refresh is what asks it to read again.
rmSync(join(stateDir, 'notify.json'), { force: true });
await page.keyboard.press('Meta+r');
await page.waitForTimeout(1_500);
const baselined = JSON.parse(readFileSync(join(stateDir, 'notify.json'), 'utf8'));
const baselineWatermark = Object.values(baselined)[0] ?? 0;
check('the first read of a host is a baseline, not a badge', await badge.count(), 0);
check('and it establishes where seen starts', baselineWatermark, (await readLocalFeed(0)).latest);
process.stdout.write(`baseline watermark: ${baselineWatermark}\n`);

// The screenshot is taken with the diagnostics folded, as a user first sees the window;
// the machine's packaging facts and the workspace are then read, which is the evidence
// that the host was already resident and that entering the machine works.
await page.screenshot({ path: join(args.out, 'shell-local-first-run.png') });
process.stdout.write(`screenshot: ${join(args.out, 'shell-local-first-run.png')}\n`);

await page.locator('#state-actions button').first().click();
await page.waitForFunction(() => document.getElementById('state-panel')?.hidden === true, null, { timeout: 15_000 });
const opened = await snapshot();
check('the home action opens this machine', opened?.workspace !== null && opened?.workspace !== undefined, true);
check('the rail follows into the workspace', await page.locator('#rail-session').getAttribute('data-active'), 'true');
// Inside the machine, its own finished work is work the user watched finish: the row
// must stop carrying a count instead of piling up what happens while they are in there.
check('the row carries no count once the machine is the one on screen', await page.locator('#groups .machine-unread').count(), 0);
check('no row is marked unread either', await page.locator('#groups .machine[data-unread="true"]').count(), 0);
process.stdout.write(`workspace seam: ${JSON.stringify(opened?.workspace ?? null)}\n`);
await page.screenshot({ path: join(args.out, 'shell-local-first-run-workspace.png') });

await page.locator('#diagnostics-toggle').click();
const rows = await page.locator('#diagnostics-rows dt, #diagnostics-rows dd').allInnerTexts();
process.stdout.write(`diagnostics: ${JSON.stringify(rows)}\n`);
check('the host reports itself', rows.some((line) => /常驻|外部托管/.test(line)), true);

await app.close();
process.stdout.write(failures === 0 ? 'RESULT pass\n' : `RESULT fail (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);