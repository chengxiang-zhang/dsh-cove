#!/usr/bin/env node
/**
 * The app-scoped sign-in, driven headless.
 *
 * `poc/fleet-run.mjs` proves the window renders a fleet. This proves the *link* behind it
 * can reach one, without an Electron window in the way: it builds the product's own
 * supervisor over the real tunnel helper, asks for the private network exactly as the
 * account chip does, mints the OAuth hand-off the way the login button does, and waits for
 * a person to finish it in a browser.
 *
 * Why headless: a window can be closed by anyone walking past, and two staged runs died
 * that way rather than by timing out. The protocol and the state machine are the same code
 * the app runs (`agent/supervisor.mjs` + `src/tunnel-client.mjs`), so this is the same
 * path with fewer moving parts - and it can re-mint a fresh hand-off on demand.
 *
 * The identity is copied out of the app's own data directory into this run's state
 * directory, handed to the helper, and deleted afterwards: the live profile is never
 * touched and no key outlives the run. The management endpoint travels the same way (from
 * that config, into `AW_MANAGEMENT_URL`), so no real endpoint is written into the source.
 *
 * Usage:
 *   node poc/fleet-sso.mjs [--identity <config.json>] [--await-login-seconds 900] [--open]
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createSupervisor } from '../agent/supervisor.mjs';
import { TunnelClient } from '../src/tunnel-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(homedir(), '.cache/anywhere-agent/bin/anywhere-tunnel');
const DEFAULT_IDENTITY = join(homedir(), 'Library', 'Application Support', 'anywhere-shell', 'config.json');
const STATE_DIR = join(HERE, 'evidence', 'fleet-sso');

function parseArgs(argv) {
  const args = { identity: DEFAULT_IDENTITY, awaitLoginMs: 900_000, open: false };
  const values = { '--identity': 'identity', '--await-login-seconds': 'awaitLoginMs' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--open') {
      args.open = true;
      continue;
    }
    const key = values[argv[i]];
    if (key === undefined) continue;
    args[key] = key === 'awaitLoginMs' ? Number(argv[i + 1]) * 1_000 : argv[i + 1];
    i += 1;
  }
  return args;
}

/** The management endpoint out of an engine config (a Go `url.URL` written as JSON). */
function managementUrlOf(file) {
  try {
    const url = JSON.parse(readFileSync(file, 'utf8'))?.ManagementURL;
    const scheme = typeof url?.Scheme === 'string' ? url.Scheme : '';
    const host = typeof url?.Host === 'string' ? url.Host : '';
    return scheme === '' || host === '' ? '' : `${scheme}://${host}`;
  } catch {
    return '';
  }
}

const args = parseArgs(process.argv.slice(2));
const out = (line) => process.stdout.write(`${line}\n`);

if (!existsSync(HELPER)) {
  out(`no tunnel helper at ${HELPER}`);
  process.exit(2);
}
if (!existsSync(args.identity)) {
  out(`no stored identity at ${args.identity}: run the app's sign-in once, then retry`);
  process.exit(2);
}

rmSync(STATE_DIR, { recursive: true, force: true });
mkdirSync(STATE_DIR, { recursive: true });
const configPath = join(STATE_DIR, 'config.json');
const statePath = join(STATE_DIR, 'state.json');
copyFileSync(args.identity, configPath);
const managementUrl = managementUrlOf(configPath);

const client = new TunnelClient({
  binary: HELPER,
  onStderr: (line) => {
    if (/error|failed|level=warning/i.test(line)) out(`[engine] ${line}`);
  },
});
client.start();

const supervisor = createSupervisor({
  engine: client,
  paths: { config: configPath, state: statePath },
  managementUrl,
  deviceName: 'anywhere-shell',
  configExists: () => existsSync(configPath),
  onState: (snapshot) => out(`state=${snapshot.state}${snapshot.detail ? ` (${snapshot.detail})` : ''}`),
  log: (line) => out(`[supervisor] ${line}`),
});

let failures = 0;
const check = (label, actual, expected) => {
  const ok = Object.is(actual, expected);
  if (!ok) failures += 1;
  out(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
};

let url = '';
try {
  out(`identity      ${args.identity}`);
  out(`endpoint      ${managementUrl === '' ? '(none in the config)' : 'present in the config'}`);
  const begun = await supervisor.begin();
  out(`after begin   state=${begun.state}${begun.loginUrl ? ' (hand-off minted)' : ''}`);

  if (begun.state === 'login-required') {
    url = begun.loginUrl;
    out(`LOGIN_URL=${url}`);
    out(`waiting up to ${args.awaitLoginMs / 1000}s for the sign-in to finish in a browser...`);
    if (args.open && url !== '') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
      out('opened the hand-off in the default browser');
    }
    const deadline = Date.now() + args.awaitLoginMs;
    while (Date.now() < deadline) {
      const result = await supervisor.loginStatus();
      if (result?.done === true) {
        out('sign-in finished');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }

  const settled = supervisor.snapshot();
  check('the app-scoped link comes up', settled.state, 'ready');
  if (settled.state === 'ready') {
    // The claim under test: with the private network up there is more than this machine.
    check('more than one machine is reachable', settled.entries.length > 1, true);
    out(`  machines: ${settled.entries.length} (registered ${settled.registered})`);
    for (const entry of settled.entries) out(`    ${entry.machine}  ${entry.host}`);
  } else {
    out(`  the link settled on ${settled.state}: ${settled.detail}`);
  }
} catch (error) {
  failures += 1;
  out(`run failed: ${error?.message ?? error}`);
} finally {
  await supervisor.stop().catch(() => undefined);
  // The identity copy is not evidence and must not outlive the run.
  rmSync(configPath, { force: true });
  rmSync(statePath, { force: true });
}

out(failures === 0 ? 'RESULT pass' : `RESULT fail (${failures})`);
process.exit(failures === 0 ? 0 : 1);