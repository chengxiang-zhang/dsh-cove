#!/usr/bin/env node
/**
 * The packaged app, opened the way a user opens it.
 *
 * `poc/local-first-run.mjs` proves the shell does the right thing when it runs from the
 * checkout; this proves the same bundle that was packaged does it too. That is a separate
 * question - the payload is copied at package time, so a build taken before a change ships
 * the old screen, and only the bundle can answer for itself.
 *
 * It launches the built `Anywhere Work.app` with its own state directory (so it never
 * touches a real profile), lets the client prepare this machine's host, and asserts the
 * window a user meets: the rail, the home, this machine's row, and the machine's own
 * finished-run count against the host that is actually running.
 *
 * Usage:
 *   node poc/packaged-ui.mjs [--app <bundle>] [--out <dir>] [--timeout-ms 120000]
 */

import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KERNEL_PORT, machineLabel, trustedHost } from '../agent/kernel.mjs';
import { badgeUrl, summarizeFeed } from '../src/notify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    app: join(HERE, '..', 'build', 'Anywhere Work.app'),
    out: join(HERE, 'evidence'),
    timeoutMs: 120_000,
  };
  const values = { '--app': 'app', '--out': 'out', '--timeout-ms': 'timeoutMs' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = values[argv[i]];
    if (key === undefined) continue;
    args[key] = key === 'timeoutMs' ? Number(argv[i + 1]) : argv[i + 1];
    i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const executable = join(args.app, 'Contents', 'MacOS', 'Electron');
const contract = join(args.app, 'Contents', 'Resources', 'app', 'packaging', 'version-contract.json');
const manifestPath = join(args.app, 'Contents', 'Resources', 'app', 'package.json');
const plistPath = join(args.app, 'Contents', 'Info.plist');
const stateDir = join(args.out, 'packaged-ui');

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures += 1;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}\n`);
}

/**
 * This machine's finished-run feed, reduced by the client's own reader.
 *
 * @param {number} [since] the watermark the badge measures from
 * @returns {Promise<number>} how many notifiable notices are newer than it
 */
async function readLocalFeed(since = 0) {
  try {
    const response = await fetch(badgeUrl(`http://127.0.0.1:${KERNEL_PORT}/`, since), { signal: AbortSignal.timeout(4_000) });
    if (response.status !== 200) return 0;
    return summarizeFeed(await response.text(), since).unread;
  } catch {
    return 0;
  }
}

/**
 * Arrives as a client that has read this host before.
 *
 * The shell treats a host it has never read as a baseline rather than as news, so a run
 * that wants to compare the badge with a number has to seed the watermark the shell
 * itself would have kept - under the same key, computed the same way.
 *
 * @param {string} dir the state directory the app is launched with
 * @param {number} back how many of the newest notices to leave unread
 * @returns {Promise<number>} the watermark written
 */
async function seedWatermark(dir, back) {
  const latest = JSON.parse(await (await fetch(badgeUrl(`http://127.0.0.1:${KERNEL_PORT}/`, 0))).text()).latest ?? 0;
  const watermark = Math.max(0, Number(latest) - back);
  writeFileSync(join(dir, 'notify.json'), `${JSON.stringify({ [trustedHost(machineLabel(hostname()))]: watermark }, null, 2)}\n`);
  return watermark;
}

let app = null;
try {
  if (!existsSync(executable)) {
    process.stdout.write(`no packaged app at ${args.app}: run scripts/package-mac.sh first\n`);
    process.exit(2);
  }
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  const watermark = await seedWatermark(stateDir, 5);
  process.stdout.write(`seeded watermark: ${watermark}\n`);
  const version = JSON.parse(readFileSync(contract, 'utf8'));
  // The product version and the build number live in the payload's own manifest, written
  // by the packager; the contract carries compatibility facts only. Both are asserted
  // below against what the running window reports, so a filename cannot be the evidence.
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  process.stdout.write(
    `bundle: ${args.app}\nmanifest: version ${manifest.version}, build ${manifest.build}, protocol ${version.protocol}\n`,
  );
  const plist = (key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath], { encoding: 'utf8' }).trim();
  check('the bundle carries the manifest version', plist('CFBundleShortVersionString'), manifest.version);
  check('the bundle build number is the git build, not the version', plist('CFBundleVersion'), String(manifest.build).split('-')[0]);
  check('the version is not the number the tool used to hardcode', manifest.version !== '0.1.0', true);

  app = await electron.launch({
    executablePath: executable,
    args: [
      `--user-data-dir=${join(stateDir, 'chromium')}`,
      '--no-sandbox',
      '--disable-gpu',
      '--engine',
      '--dir',
      stateDir,
    ],
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // The bundle answering for itself: the resources path is the app we packaged, not the
  // checkout the sources live in.
  const resourcesPath = await app.evaluate(() => process.resourcesPath);
  check('the window came from the packaged bundle', resourcesPath.includes('Anywhere Work.app'), true);

  const snapshot = () => app.evaluate(() => globalThis.__awSnapshot ?? null);
  const deadline = Date.now() + args.timeoutMs;
  let settled = await snapshot();
  while (Date.now() < deadline && !['local', 'error'].includes(settled?.state)) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    settled = await snapshot();
  }
  process.stdout.write(`main process: ${JSON.stringify(settled)}\n`);
  check('the packaged client prepares this machine itself', settled?.state, 'local');
  // The window's own identity, read from the running process rather than from the files
  // beside it: this is the pair the diagnostics block shows, and the pair that lets two
  // builds of one version tell themselves apart.
  check('the running window reports the manifest version', settled?.version, manifest.version);
  check('the running window reports the git build number', settled?.build, String(manifest.build));

  await page.waitForFunction(() => document.getElementById('status-label')?.innerText === '本机可用', null, { timeout: 15_000 });
  check('status line', await page.locator('#status-label').innerText(), '本机可用');
  // The rail and the home are this build's screen; a bundle taken before them would show
  // the old two-pane shell with no rail and a workspace covering the pane.
  check('the rail shipped', await page.locator('.rail .rail-button').count(), 4);
  check('the rail marks the home', await page.locator('#rail-machines').getAttribute('data-active'), 'true');
  check('the front door shipped', await page.locator('#state-panel').getAttribute('data-kind'), 'home');
  check('the home names the machine', /打开 .* 的工作区/.test(await page.locator('#state-actions button').first().innerText()), true);
  check('this machine has a row', await page.locator('#groups .machine').count(), 1);

  const unread = await readLocalFeed(watermark);
  const badge = page.locator('#groups .machine-unread');
  if (unread > 0) {
    check('the badge matches the running host', await badge.first().innerText(), String(unread));
  } else {
    check('no badge when the host reports nothing', await badge.count(), 0);
  }

  await page.locator('#state-actions button').first().click();
  await page.waitForFunction(() => document.getElementById('state-panel')?.hidden === true, null, { timeout: 20_000 });
  const opened = await snapshot();
  check('the packaged app opens a workspace', opened?.workspace !== null && opened?.workspace !== undefined, true);
  check('the rail follows into the workspace', await page.locator('#rail-session').getAttribute('data-active'), 'true');
  await page.screenshot({ path: join(args.out, 'packaged-ui.png') });
  process.stdout.write(`screenshot: ${join(args.out, 'packaged-ui.png')}\n`);
} catch (error) {
  failures += 1;
  process.stdout.write(`run failed: ${error?.message ?? error}\n`);
} finally {
  if (app !== null) await app.close().catch(() => undefined);
}

process.stdout.write(failures === 0 ? 'RESULT pass\n' : `RESULT fail (${failures})\n`);
process.exit(failures === 0 ? 0 : 1);