#!/usr/bin/env node
/**
 * Windows smoke: the installed app, opened, read and photographed on a real Windows runner.
 *
 * This exists because nobody on this project owns a Windows machine, and "the Windows
 * installer was built" is not the same claim as "the Windows app opens". It installs
 * nothing itself - CI has already run the installer - it attaches to the installed
 * executable the way the macOS checks attach to the .app, and writes what it saw.
 *
 * Run by `.github/workflows/windows-smoke.yml`; exits non-zero only when an assertion the
 * product promised fails, and always writes `facts.json` so a red run still says why.
 */

import { _electron as electron } from 'playwright';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const EXE = process.env.AW_EXE ?? '';
const OUT = process.env.AW_OUT ?? 'artifacts';
mkdirSync(OUT, { recursive: true });

const facts = { exe: EXE, platform: process.platform, started: false, checks: [], error: '' };
let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  facts.checks.push({ name, actual, expected, ok });
  if (!ok) {
    failures += 1;
  }
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}\n`);
}

const stateDir = join(OUT, 'state');
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });

let app = null;
try {
  if (EXE === '') {
    throw new Error('AW_EXE is not set');
  }
  app = await electron.launch({
    executablePath: EXE,
    args: [`--user-data-dir=${join(stateDir, 'chromium')}`, '--dir', stateDir, '--disable-gpu'],
    timeout: 120_000,
  });
  const page = await app.firstWindow({ timeout: 120_000 });
  await page.waitForLoadState('domcontentloaded');
  facts.started = true;

  await page.waitForFunction(() => document.querySelectorAll('.tab').length > 0, null, { timeout: 90_000 });
  const home = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tab .tab-title')].map((node) => node.textContent),
    homeVisible: document.getElementById('home')?.hidden === false,
    bannerHidden: document.getElementById('banner')?.hidden ?? true,
    cards: document.querySelectorAll('.card').length,
    groups: [...document.querySelectorAll('.group h2')].map((node) => node.textContent.trim()),
    width: window.innerWidth,
    height: window.innerHeight,
    noAddressBar: document.querySelectorAll('.omnibox, #address').length === 0,
  }));
  facts.home = home;
  check('the window opens on one tab', home.tabs.length, 1);
  check('the tab is the home', home.tabs[0], '首页');
  check('the home is on screen', home.homeVisible, true);
  check('a healthy install shows no banner', home.bannerHidden, true);
  check('there is no address bar', home.noAddressBar, true);
  check('the window has a real size', home.width > 600 && home.height > 400, true);
  await page.screenshot({ path: join(OUT, 'windows-home.png') });

  // The settings tab is the second screen every install has, and it carries the facts a
  // person needs when something is wrong.
  await page.click('#open-settings');
  await page.waitForFunction(() => !document.getElementById('settings')?.hidden, null, { timeout: 30_000 });
  const settings = await page.evaluate(() => ({
    active: document.querySelector('.tab[data-active="true"] .tab-title')?.textContent ?? '',
    rows: document.querySelectorAll('#settings .row').length,
    values: [...document.querySelectorAll('#settings .row .value')].map((node) => node.textContent),
  }));
  facts.settings = settings;
  check('settings opens as a tab', settings.active, '设置');
  check('the settings page has facts on it', settings.rows > 2, true);
  await page.screenshot({ path: join(OUT, 'windows-settings.png') });

  // Back to the home, then open the machine: on a runner there is no DSH behind it, so
  // what is asserted is that the tab opens and the home steps aside - not that a page
  // loaded, which would be asserting the runner has a workspace.
  await page.click('#tab-new');
  await page.waitForFunction(() => document.getElementById('home')?.hidden === false, null, { timeout: 30_000 });
  await page.click('.card[data-service-id^="machine:"]');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 2, null, { timeout: 60_000 });
  const opened = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tab .tab-title')].map((node) => node.textContent),
    homeHidden: document.getElementById('home')?.hidden === true,
  }));
  facts.opened = opened;
  check('a machine opens as a tab', opened.tabs.length, 2);
  check('the home steps aside', opened.homeHidden, true);
  await page.screenshot({ path: join(OUT, 'windows-workspace-tab.png') });
} catch (error) {
  facts.error = String(error?.message ?? error);
  failures += 1;
  process.stdout.write(`  FAIL run: ${facts.error}\n`);
} finally {
  writeFileSync(join(OUT, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`);
  try {
    await app?.close();
  } catch {
    // the window is gone
  }
}

process.stdout.write(failures === 0 ? '\nwindows-smoke: all checks passed\n' : `\nwindows-smoke: ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
