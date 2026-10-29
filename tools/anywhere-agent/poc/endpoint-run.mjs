#!/usr/bin/env node
/**
 * The sign-in path, on a real engine: no address, then the deployment's own.
 *
 * This is the run behind the failure the walkthrough found. The shipped desktop had no
 * address at all on a machine that had never enrolled: it dialled the placeholder in the
 * source, spent half a minute on "正在接入", and ended on an engine error that never named
 * the server - so "登录" was unreachable, and nothing on screen could fix it.
 *
 * Phase 1  an install with no address anywhere: the window asks for one, starts no engine,
 *          and offers the way back to this machine instead of a link that cannot exist.
 * Phase 2  the address the deployment uses is typed into that field. The engine then dials
 *          a real management server, the window names it, and the sign-in screen appears
 *          with a link that is minted on the click. Re-minting is what the buttons do, so
 *          the screen has to survive a second press: the hand-off the engine issues is
 *          short-lived, and the window used to turn into "连不上" about half a minute after
 *          the button was pressed, while the person was still in their browser.
 *
 * The address travels the way the other runs hand it over: `--management-url` or
 * `AW_MANAGEMENT_URL`, never a value in the repository. Nothing is written outside this
 * run's own state directory, and the live profile is not touched. The browser step itself
 * belongs to a person, which is where this run stops.
 *
 * Usage:
 *   AW_MANAGEMENT_URL=https://netbird.example:443 node poc/endpoint-run.mjs [--out <dir>]
 */

import { _electron as electron } from 'playwright';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = join(HERE, '..', 'shell');

function parseArgs(argv) {
  const args = {
    electron: process.env.AW_ELECTRON ?? '',
    out: join(HERE, 'evidence'),
    managementUrl: process.env.AW_MANAGEMENT_URL ?? '',
  };
  const values = { '--electron': 'electron', '--out': 'out', '--management-url': 'managementUrl' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = values[argv[i]];
    if (key === undefined) continue;
    args[key] = argv[i + 1];
    i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const stateDir = join(args.out, 'endpoint-run');
const realHost = (() => {
  try {
    return new URL(args.managementUrl).host;
  } catch {
    return '';
  }
})();

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures += 1;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}\n`);
}

/** The seam carries the state the window is rendering, which is what these steps wait on. */
async function settle(app, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let seam = await app.evaluate(() => globalThis.__awSnapshot ?? null);
  while (Date.now() < deadline) {
    if (seam && predicate(seam)) return seam;
    await new Promise((resolve) => setTimeout(resolve, 500));
    seam = await app.evaluate(() => globalThis.__awSnapshot ?? null);
  }
  process.stdout.write(`  timed out waiting for ${label}: ${JSON.stringify(seam?.state)}\n`);
  return seam;
}

const dom = (page) =>
  page.evaluate(() => {
    const text = (id) => document.getElementById(id)?.textContent ?? '';
    return {
      title: text('window-title'),
      panelState: document.getElementById('state-panel')?.dataset.state ?? '',
      panelTitle: text('state-title'),
      panelBody: text('state-body'),
      server: text('state-server'),
      fieldHidden: document.getElementById('server-field')?.hidden ?? true,
      note: document.getElementById('server-note')?.hidden ? '' : text('server-note'),
      actions: [...document.querySelectorAll('#state-actions button')].map((button) => button.textContent),
      account: { name: text('account-name'), line: text('account-line'), action: text('account-action') },
      hostTitles: [...document.querySelectorAll('#groups .machine-host')].map((host) => host.getAttribute('title') ?? ''),
      bodyText: document.body.innerText,
    };
  });

/** The address this run's install has recorded, printed so a failure names its own state. */
function readSettingsFile() {
  const file = join(stateDir, 'settings.json');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '(absent)';
}

if (realHost === '') {
  process.stdout.write('no management endpoint to enroll against: pass --management-url or AW_MANAGEMENT_URL\n');
  process.exit(2);
}

rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });

let app = null;
try {
  app = await electron.launch({
    executablePath: args.electron,
    // The environment is deliberately without a deployment value: phase 1 is the install
    // nobody has told where the fleet is.
    env: { ...process.env, AW_MANAGEMENT_URL: '' },
    args: [`--user-data-dir=${join(stateDir, 'chromium')}`, '--no-sandbox', '--disable-gpu', SHELL_DIR, '--dir', stateDir],
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  const ready = await settle(app, (seam) => seam.state === 'local', 90_000, 'this machine to be ready');
  check('this machine is ready without any account', ready?.state, 'local');

  // ---------------------------------------------------------------- phase 1
  process.stdout.write('phase 1: an install with no address\n');
  await page.click('#account');
  const asked = await settle(app, (seam) => seam.state === 'login-required', 60_000, 'the answer to "other machines"');
  await new Promise((resolve) => setTimeout(resolve, 800));
  const panel = await dom(page);
  check('the answer is the address panel, not a dial', asked?.state, 'login-required');
  check('the panel asks for the address', panel.panelTitle, '填服务器地址');
  check('the panel names the missing address', panel.server, '服务器：还没有地址');
  check('the panel offers the field and the way back', panel.actions.join('|'), '设置服务器|改用本机');
  check('the chip leads to the address', panel.account.action, '设置服务器');
  check('this machine is still named in the title', /·/.test(panel.title), true);
  check('no engine error is reported', /连不上/.test(panel.panelTitle), false);
  await page.screenshot({ path: join(args.out, 'endpoint-no-address.png') });

  // A value that is not an address is refused where it was typed.
  await page.click('#action-set-server');
  await page.fill('#server-input', 'netbird.corp.example');
  await page.click('#server-save');
  await new Promise((resolve) => setTimeout(resolve, 600));
  const refused = await dom(page);
  check('a value with no scheme is refused', refused.note.includes('请填完整地址'), true);
  check('the field stays open after a refusal', refused.fieldHidden, false);
  await page.screenshot({ path: join(args.out, 'endpoint-field-refused.png') });

  // ---------------------------------------------------------------- phase 2
  process.stdout.write(`phase 2: the deployment's own address (${realHost})\n`);
  await page.fill('#server-input', args.managementUrl);
  await page.click('#server-save');
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  process.stdout.write(
    `  after the save: field=${JSON.stringify(await page.locator('#server-input').inputValue().catch(() => ''))} panel=${JSON.stringify(await page.locator('#state-title').innerText())} settings=${JSON.stringify(readSettingsFile())}\n`,
  );
  const login = await settle(app, (seam) => seam.state === 'login-required' && seam.hasLoginUrl, 180_000, 'the sign-in hand-off');
  await new Promise((resolve) => setTimeout(resolve, 600));
  const screen = await dom(page);
  check('the fleet link reaches the sign-in screen', login?.state, 'login-required');
  check('the panel is the sign-in, not the address field', screen.panelTitle, '登录');
  check('the address the user typed is named as their own', screen.server, `服务器：${realHost}（自建）`);
  check('the sign-in is one button', screen.actions.join('|'), '登录');
  check('the sign-in link is not on screen', /https?:\/\//.test(screen.bodyText), false);
  check('the title names this machine', /·/.test(screen.title), true);
  check('the machine row carries its full address as hover text', screen.hostTitles.some((host) => host.startsWith('dsh.')), true);
  const minted = (() => {
    try {
      return new URL(login.loginUrl).host;
    } catch {
      return '(not a url)';
    }
  })();
  check('the hand-off points at the server this install was given', minted, realHost);
  await page.screenshot({ path: join(args.out, 'endpoint-login.png') });

  // The button re-mints rather than trusting what is on screen, and the engine's hand-off
  // is short-lived. This asks for the same hand-off the button asks for, without opening a
  // browser on the machine running the run; what is being asserted is that the screen
  // outlives a renewal instead of turning into "连不上".
  const renewed = await page.evaluate(() => window.anywhere.freshLogin());
  process.stdout.write(`  renewed hand-off: ok=${renewed?.ok} host=${(() => { try { return new URL(renewed?.url ?? '').host } catch { return '(none)' } })()}\n`);
  await new Promise((resolve) => setTimeout(resolve, 45_000));
  const survived = await dom(page);
  const stillUp = await app.evaluate(() => globalThis.__awSnapshot?.state ?? '');
  check('the sign-in screen survives a renewal', stillUp, 'login-required');
  check('its button is still there', survived.actions.includes('登录'), true);
  check('and the address is still named', survived.server, `服务器：${realHost}（自建）`);
  await page.screenshot({ path: join(args.out, 'endpoint-login-after-renewal.png') });

} catch (error) {
  failures += 1;
  process.stdout.write(`  FAIL run: ${error?.message ?? error}\n`);
} finally {
  try {
    await app?.close();
  } catch {
    /* the window is gone */
  }
  writeFileSync(join(args.out, 'endpoint-run.json'), `${JSON.stringify({ managementHost: realHost, failures }, null, 2)}\n`);
  process.stdout.write(`RESULT ${failures === 0 ? 'pass' : 'fail'} (${failures})\n`);
  process.exit(failures === 0 ? 0 : 1);
}