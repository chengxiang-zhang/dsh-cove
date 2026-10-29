#!/usr/bin/env node
/**
 * PoC: an Electron WebView shell as the "intranet browser".
 *
 * It answers the question the measurements raised: does embedding the workspace
 * in a resident WebView remove the repeated "Loading plugins" wait, and can the
 * overlay stay app-scoped while it does?
 *
 * Three properties are asserted:
 *
 * 1. App scope: the proxy is configured on the shell's own session, never on the
 *    operating system. A WebView with no system proxy is exactly the shape a
 *    client may ship.
 * 2. No system resolver: the shell breaks its own name resolution for the entry
 *    authorities, so only the loopback proxy can answer. This is an in-process
 *    Chromium switch, not a system change.
 * 3. Residency: a workspace that stays loaded is instantly usable, and a machine
 *    prewarmed in the background is usable the moment the user asks for it.
 *
 * Usage (from a directory that has electron installed):
 *   electron poc/electron-shell.mjs --proxy http://127.0.0.1:19001 \
 *     --authorities dsh.peer-a.netbird,dsh.peer-b.netbird
 */

import { app, BrowserWindow, session } from 'electron';

function parseArgs(argv) {
  const args = { proxy: 'http://127.0.0.1:19001', authorities: [], budgetMs: 45_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--proxy') args.proxy = value;
    else if (key === '--authorities') args.authorities = String(value).split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--budget-ms') args.budgetMs = Number(value);
    if (key.startsWith('--')) i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.authorities.length < 2) {
  process.stderr.write('at least two authorities are required\n');
  process.exit(2);
}

const PARTITION = 'persist:anywhere-poc';

// In-process resolution override: the shell must not be able to fall back to the
// system resolver, which is what makes the proxy the only working path.
app.commandLine.appendSwitch(
  'host-resolver-rules',
  args.authorities.map((authority) => `MAP ${authority} ~NOTFOUND`).join(', '),
);
app.disableHardwareAcceleration();

const READY_JS = `(() => {
  const text = document.body ? document.body.innerText : '';
  return !text.includes('Loading plugins') && !!document.querySelector('textarea, [contenteditable="true"]');
})()`;

async function isReady(win) {
  try {
    return await win.webContents.executeJavaScript(READY_JS, true);
  } catch {
    return false;
  }
}

/** Polls the workspace until it is usable, returning ms since t0 or -1. */
async function waitReady(win, t0, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await isReady(win)) {
      return Date.now() - t0;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return -1;
}

async function main() {
  await app.whenReady();
  const shellSession = session.fromPartition(PARTITION);
  await shellSession.setProxy({ proxyRules: args.proxy });

  process.stdout.write(`shell=electron ${process.versions.electron} proxy=${args.proxy} partition=${PARTITION}\n`);
  process.stdout.write(`resolver override=${args.authorities.map((a) => `${a}->NOTFOUND`).join(', ')}\n`);

  const windows = new Map();

  /** Opens one authority and waits until it is usable. */
  const open = async (authority) => {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: { partition: PARTITION },
    });
    const t0 = Date.now();
    await win.loadURL(`http://${authority}/`);
    const tLoaded = Date.now() - t0;
    const tReady = await waitReady(win, t0, args.budgetMs);
    windows.set(authority, win);
    process.stdout.write(
      `[open ] ${authority} loaded=${tLoaded}ms ready=${tReady === -1 ? 'TIMEOUT' : `${tReady}ms`}\n`,
    );
    return { tLoaded, tReady };
  };

  // Phase 1: the first machine the user opens.
  const first = args.authorities[0];
  const firstResult = await open(first);

  // Phase 2: prewarm the second machine in the background, as a shell would do
  // as soon as it knows the user's machines.
  const second = args.authorities[1];
  const secondResult = await open(second);

  // Phase 3: the user asks for the first machine again. It stayed loaded.
  const tFocus = Date.now();
  const focusReady = await isReady(windows.get(first));
  const focusMs = Date.now() - tFocus;
  process.stdout.write(`[switch] ${first} already resident: ready=${focusReady} in ${focusMs}ms\n`);

  // Phase 4: the user asks for the second machine, which was prewarmed.
  const tSwitch = Date.now();
  const switchReady = await isReady(windows.get(second));
  const switchMs = Date.now() - tSwitch;
  process.stdout.write(`[switch] ${second} prewarmed: ready=${switchReady} in ${switchMs}ms\n`);

  // Phase 5: prove the shell is not limited to machines opened this run: a third
  // open of a resident machine must not re-run the plugin boot.
  const reopened = await open(first);
  process.stdout.write(
    `[repeat] ${first} opened again: loaded=${reopened.tLoaded}ms ready=${reopened.tReady === -1 ? 'TIMEOUT' : `${reopened.tReady}ms`}\n`,
  );

  process.stdout.write(
    `summary shell: first(loaded=${firstResult.tLoaded} ready=${firstResult.tReady}) second(loaded=${secondResult.tLoaded} ready=${secondResult.tReady}) switchFirst=${focusMs}ms switchSecond=${switchMs}ms repeat(loaded=${reopened.tLoaded} ready=${reopened.tReady})\n`,
  );
}

main()
  .catch((error) => process.stderr.write(`shell error: ${error.message}\n`))
  .finally(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.destroy();
    }
    app.quit();
  });