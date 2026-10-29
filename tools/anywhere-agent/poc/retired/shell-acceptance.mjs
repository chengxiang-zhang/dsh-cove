#!/usr/bin/env node
/**
 * RETIRED (2026-10-19). Kept as history, not as a gate.
 *
 * It asserts on the shell's first DOM - `#state-pill`, `#machines`, `#list-meta`,
 * `#state-login`, `#login-url`, and a workspace in a second window - none of which
 * exists any more: the shell became one window with an embedded workspace, and the
 * sign-in is a button rather than a link on screen. Every run of this file fails on
 * its first selector.
 *
 * The current harnesses are:
 *   poc/shell-states.mjs    every window state, asserted in the DOM, both schemes
 *   poc/packaged-e2e.mjs    the packaged app, end to end, against real machines
 *
 * Acceptance run for the shell: launch it the way a user would, then assert on
 * real UI state and capture the screenshots a human reviews.
 *
 * Two modes, matching the shell's own:
 *   --engine --dir <path>   the real agent, so the login state is the real one
 *   --proxy <url>           an already-running agent, for the machine list
 *
 * The screenshots are the evidence; the assertions are what fails the run.
 *
 * Usage:
 *   node poc/retired/shell-acceptance.mjs --engine --dir /tmp/aw-fresh --theme dark --shot <path>
 *   node poc/retired/shell-acceptance.mjs --proxy http://127.0.0.1:19001 --theme light --shot <path>
 */

import { _electron as electron } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = join(HERE, '..', '..', 'shell');

function parseArgs(argv) {
  const args = {
    proxy: '',
    engine: false,
    dir: '',
    theme: 'dark',
    electron: process.env.AW_ELECTRON ?? '',
    shot: join(HERE, 'evidence', 'shell.png'),
    workspaceShot: '',
    openWorkspace: false,
    expect: '',
    bundle: false,
    waitMs: 25_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--proxy') args.proxy = value;
    else if (key === '--electron') args.electron = value;
    else if (key === '--dir') args.dir = value;
    else if (key === '--theme') args.theme = value;
    else if (key === '--shot') args.shot = value;
    else if (key === '--workspace-shot') args.workspaceShot = value;
    else if (key === '--expect') args.expect = value;
    else if (key === '--wait-ms') args.waitMs = Number(value);
    else if (key === '--open-workspace') args.openWorkspace = true;
    else if (key === '--engine') args.engine = true;
    else if (key === '--bundle') args.bundle = true;
    // A boolean flag must not consume the next argument: doing so swallowed the
    // following option (for example `--engine --dir X` lost the directory) and the
    // run then quietly used a default profile instead.
    if (!['--open-workspace', '--engine'].includes(key)) i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const out = (line) => process.stdout.write(`${line}\n`);

// A packaged app is its own entry point: no source directory is passed.
const shellArgs = args.bundle ? [] : [SHELL_DIR];
if (args.engine) {
  shellArgs.push('--engine');
  if (args.dir) {
    shellArgs.push('--dir', args.dir);
  }
}
if (args.proxy) {
  shellArgs.push('--proxy', args.proxy);
}

const app = await electron.launch({ executablePath: args.electron, args: shellArgs, colorScheme: args.theme });
// A failed assertion must not leave the app (and its engine) running: an orphaned
// helper keeps a profile alive and makes the next run lie about its own state.
process.on('exit', () => {
  app.close().catch(() => undefined);
});
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');

// Renderer diagnostics belong in the run output: a screen that never leaves
// "starting" is usually a renderer exception, and the console says which.
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300));
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 300)}`));

// The state pill carries the state the agent reported; waiting on it is waiting
// on the agent, not on a timer. A wait that fails dumps what the screen actually
// showed, because "it never became ready" is not a diagnosis.
try {
  if (args.expect) {
    await page.waitForFunction(
      (expected) => document.getElementById('state-pill')?.dataset.state === expected,
      args.expect,
      { timeout: args.waitMs },
    );
  } else {
    await page.waitForFunction(
      () => !['starting', 'connecting'].includes(document.getElementById('state-pill')?.dataset.state),
      null,
      { timeout: args.waitMs },
    );
  }
} catch (error) {
  const pill = await page.locator('#state-pill').getAttribute('data-state').catch(() => '?');
  const text = await page.locator('#state-text').innerText().catch(() => '?');
  const json = await page.evaluate(() => JSON.stringify(window.__lastState ?? null)).catch(() => 'null');
  out(`WAIT FAILED: expected=${args.expect || 'settled'} saw=${pill} (${text})`);
  out(`renderer errors: ${consoleErrors.length}`);
  for (const line of consoleErrors.slice(0, 6)) out(`  ${line}`);
  out(`last state: ${json}`);
  await page.screenshot({ path: args.shot }).catch(() => undefined);
  out(`screenshot (failure state): ${args.shot}`);
  await app.close().catch(() => undefined);
  process.exit(1);
}

const state = await page.locator('#state-pill').getAttribute('data-state');
const stateText = await page.locator('#state-text').innerText();
const machines = await page.locator('#machines .machine').count();
const names = await page.locator('.machine-name').allInnerTexts();
const meta = await page.locator('#list-meta').innerText();
const loginVisible = await page.locator('#state-login').isVisible();
const loginUrl = loginVisible ? await page.locator('#login-url').innerText() : '';
out(`state=${state} (${stateText})`);
out(`machines=${machines} ${JSON.stringify(names.slice(0, 8))}`);
out(`list meta=${JSON.stringify(meta)}`);
if (loginVisible) {
  out(`login url present=${loginUrl.startsWith('https://')} length=${loginUrl.length}`);
}
if (consoleErrors.length) {
  out(`renderer errors: ${consoleErrors.length}`);
  for (const line of consoleErrors.slice(0, 5)) out(`  ${line}`);
}
await page.screenshot({ path: args.shot });
out(`screenshot: ${args.shot}`);

if (args.openWorkspace && machines > 0) {
  await page.locator('#machines .machine').first().click();
  const deadline = Date.now() + 120_000;
  let workspace = null;
  while (Date.now() < deadline && !workspace) {
    workspace = app.windows().find((candidate) => candidate !== page && candidate.url().startsWith('http://dsh.')) ?? null;
    if (!workspace) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  if (workspace) {
    await workspace.waitForLoadState('domcontentloaded');
    out(`workspace: ${workspace.url()} title=${await workspace.title()}`);
    await workspace.waitForTimeout(20_000);
    if (args.workspaceShot) {
      await workspace.screenshot({ path: args.workspaceShot });
      out(`workspace screenshot: ${args.workspaceShot}`);
    }
  } else {
    out('workspace: not opened');
  }
  out(`list still resident: ${await page.locator('#machines .machine').count()} machines`);
}

await app.close();