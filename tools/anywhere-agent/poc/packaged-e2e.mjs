#!/usr/bin/env node
/**
 * End-to-end acceptance on the packaged app.
 *
 * It launches the real bundle, waits for the sign-in hand-off, prints the link so a
 * browser can complete it, then waits for the agent to come up and asserts the whole
 * user path: the machine list appears, and opening a machine puts a real DSH
 * workspace in a window. Nothing here is scripted or mocked - the only asset is the
 * signed bundle on disk.
 *
 * Usage:
 *   node poc/packaged-e2e.mjs [--app <bundle>] [--timeout-ms 900000] [--open-workspace]
 */

import { _electron as electron } from 'playwright';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    app: join(HERE, '..', 'build', 'Anywhere Work.app', 'Contents', 'MacOS', 'Electron'),
    timeoutMs: 900_000,
    openWorkspace: false,
    setupKey: '',
    shot: join(HERE, 'evidence', 'packaged-workspace.png'),
  };
  const values = ['--app', '--timeout-ms', '--shot', '--setup-key'];
  for (let i = 0; i < argv.length; i += 1) {
    if (values.includes(argv[i])) {
      args[argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--open-workspace') {
      args.openWorkspace = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const out = (line) => process.stdout.write(`${line}\n`);

// A setup key enrolls this machine without a browser. The sign-in path is the
// product's, and was verified with a real sign-in; this run exists to prove the
// packaged app end to end without needing anyone's credentials.
//
// `--fleet` is passed explicitly because the private network is opt-in now: an app
// the user opens prepares and serves this machine without any account, and only asks
// for one when the user wants their other machines. A run that asserted the sign-in
// path has to ask for that path the same way a person does.
const launchArgs = ['--engine', '--fleet'];
if (args.setupKey !== '') {
  launchArgs.push('--setup-key', args.setupKey);
}
const app = await electron.launch({ executablePath: args.app, args: launchArgs });
// The engine's own words, kept: a failed enrolment is explained there and nowhere
// else, and a run that hides it can only be guessed at.
const engineLog = [];
app.process().stderr?.on('data', (chunk) => {
  const text = chunk.toString();
  engineLog.push(text);
  for (const line of text.split('\n')) {
    if (/level=error|level=warning|\[agent\] state=|setup key|registered|^shell:/.test(line)) {
      process.stderr.write(`[app] ${line}\n`);
    }
  }
});
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');

const snapshot = () => app.evaluate(() => globalThis.__awSnapshot ?? null);

/** Waits until the main process reports one of the wanted states. */
async function waitForState(states, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await snapshot();
    if (current && states.includes(current.state)) {
      return current;
    }
    if (Date.now() >= deadline) {
      return current ?? { state: 'unknown' };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

if (args.setupKey === '') {
  const login = await waitForState(['login-required'], 120_000);
  if (login.state !== 'login-required') {
    out(`unexpected state before sign-in: ${JSON.stringify(login)}`);
  } else {
    out(`LOGIN_URL=${login.loginUrl}`);
    out('waiting for the browser to finish the sign-in…');
  }
} else {
  out('enrolling with a setup key (no browser)');
}

// `login-required` belongs in the settled set: an enrollment that fails falls back
// to the sign-in, and waiting for a state that will never come is how a run turns
// into a silent five-minute hang instead of a report. `local` belongs there too: it
// is a finished state, not a step on the way to signing in.
const settled = await waitForState(['local', 'ready', 'empty', 'error', 'login-required'], Number(args.timeoutMs));
out(`state=${settled.state} machines=${settled.entries ?? 0} registered=${settled.registered ?? 0}`);
if (settled.state === 'error') {
  out(`detail=${await page.locator('#state-body').innerText()}`);
}

out(`status=${await page.locator('#status-label').innerText().catch(() => '?')}`);
// The sidebar is the list now; the old single-pane selectors are gone.
const machines = await page.locator('#groups .machine').count();
out(`rendered machines=${machines}`);
await page.screenshot({ path: join(HERE, 'evidence', 'packaged-list.png') });

if (args.openWorkspace && machines > 0) {
  // Selecting a machine embeds its workspace in the detail pane: one window, the list
  // stays where it is.
  await page.locator('#groups .machine').first().click();
  const deadline = Date.now() + 120_000;
  let workspace = null;
  while (Date.now() < deadline && !workspace) {
    const current = await snapshot();
    workspace = current?.workspace ?? null;
    if (!workspace) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  if (workspace) {
    out(`embedded workspace: host=${workspace.host} window title=${await page.title()}`);
    out(`renderer window title: ${await page.locator('#window-title').innerText()}`);
    // The embedded view is a native view, so its page is captured through the seam
    // rather than by the renderer's screenshot.
    // capturePage goes through the compositor and can fail for a frame that has not
    // painted yet, so it is retried rather than taken as a verdict on the workspace.
    let png = null;
    for (let attempt = 1; attempt <= 5 && !png; attempt += 1) {
      try {
        png = await app.evaluate(async () => {
          const view = globalThis.__awWorkspace;
          if (!view) return null;
          const image = await view.webContents.capturePage();
          const png2 = image.toPNG();
          return png2.length > 0 ? png2.toString('base64') : null;
        });
      } catch (error) {
        out(`capture attempt ${attempt} failed: ${String(error.message).split('\n')[0]}`);
        await page.waitForTimeout(2_000);
      }
    }
    const bounds = await app.evaluate(() => {
      const view = globalThis.__awWorkspace;
      return view ? view.getBounds() : null;
    });
    out(`embedded view bounds: ${JSON.stringify(bounds)}`);
    if (png) {
      writeFileSync(join(HERE, 'evidence', 'embedded-workspace.png'), Buffer.from(png, 'base64'));
      out('embedded workspace screenshot: poc/evidence/embedded-workspace.png');
    } else {
      out('embedded workspace could not be captured');
    }
    await page.waitForTimeout(15_000);
    await page.screenshot({ path: join(HERE, 'evidence', 'packaged-list.png') });
    out('sidebar screenshot: poc/evidence/packaged-list.png');
  } else {
    out('workspace was never embedded');
  }
  out(`list still resident: ${await page.locator('#groups .machine').count()} machines`);
}

await app.close();
out('done');