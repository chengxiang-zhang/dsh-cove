#!/usr/bin/env node
/**
 * The agent's side of the window contract.
 *
 * The shell cannot be aimed at: it has no address bar and no scripting hole. What it has is
 * a file that says where to reach it and a token to prove you may. This client reads that
 * file, asks what tabs exist, claims one, and prints the CDP endpoint a browser session can
 * attach to - which is the whole path an agent takes to work inside the window.
 *
 * Commands:
 *   state                     everything the window will say: tabs, titles, who is driving
 *   tabs                      just the tab list, one per line
 *   claim <tabId> [--tier read-only|control] [--by <name>]
 *   release <tabId> [--by <name>]
 *   release-all [--by <name>]
 *   cdp                       the CDP endpoint this window's pages can be attached to
 *
 * Where the window is: `--dir <state dir>` (the shell's `--dir`), or AW_AGENT_BRIDGE_DIR.
 * The token is never passed on the command line by default - it is read from the file the
 * window wrote, so it does not end up in a shell history.
 *
 * Exit codes: 0 ok, 1 the window refused, 2 nothing to talk to.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Reads the endpoint file the shell writes; a missing file is "no window to talk to". */
export function readBridgeFile(dir) {
  const file = join(dir, 'agent-bridge.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed?.url !== 'string' || typeof parsed?.token !== 'string') {
      return null;
    }
    return { ...parsed, file };
  } catch {
    return null;
  }
}

/** The port Chromium chose for CDP, from the file it leaves in the profile. */
export function readCdpEndpoint(dir) {
  for (const candidate of [join(dir, 'chromium', 'DevToolsActivePort'), join(dir, 'DevToolsActivePort')]) {
    try {
      const port = Number(readFileSync(candidate, 'utf8').split('\n')[0]);
      if (port > 0) {
        return `http://127.0.0.1:${port}`;
      }
    } catch {
      // try the next location
    }
  }
  return '';
}

/**
 * One call against the window.
 *
 * @param {{ url: string, token: string }} bridge
 * @param {string} path
 * @param {object} [body] when given, the call is a POST
 */
export async function bridgeCall(bridge, path, body) {
  const response = await fetch(`${bridge.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, ok: response.ok, body: payload };
}

/** The tab list, reduced to what a caller needs to choose one. */
export function tabLines(state) {
  const tabs = Array.isArray(state?.tabs) ? state.tabs : [];
  return tabs.map((tab) => {
    const driving = tab.agent ? ` [${tab.agent.tier} by ${tab.agent.by ?? 'agent'}]` : '';
    const active = tab.active ? '*' : ' ';
    return `${active} ${tab.id}\t${tab.title ?? ''}${driving}`;
  });
}

function parseArgs(argv) {
  const args = { command: argv[0] ?? 'state', rest: [], tier: 'read-only', by: process.env.AW_AGENT_NAME ?? 'agent', dir: process.env.AW_AGENT_BRIDGE_DIR ?? '' };
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--tier') {
      args.tier = argv[i + 1] ?? 'read-only';
      i += 1;
    } else if (key === '--by') {
      args.by = argv[i + 1] ?? 'agent';
      i += 1;
    } else if (key === '--dir') {
      args.dir = argv[i + 1] ?? '';
      i += 1;
    } else if (key === '--url') {
      args.url = argv[i + 1] ?? '';
      i += 1;
    } else if (key === '--token') {
      args.token = argv[i + 1] ?? '';
      i += 1;
    } else {
      args.rest.push(key);
    }
  }
  return args;
}

/**
 * Runs one command and returns what should be printed and the exit code.
 *
 * Pure enough to test: the only side effects are the calls to the window.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string }} [options]
 */
export async function runBridgeCli(argv, options = {}) {
  const args = parseArgs(argv);
  const dir = args.dir !== '' ? args.dir : options.cwd ?? process.cwd();

  if (args.command === 'cdp') {
    const endpoint = readCdpEndpoint(dir);
    if (endpoint === '') {
      return { exitCode: 2, out: 'no CDP endpoint: the window was not started with --remote-debugging-port\n' };
    }
    return { exitCode: 0, out: `${endpoint}\n` };
  }

  const bridge = args.url !== undefined && args.token !== undefined ? { url: args.url, token: args.token } : readBridgeFile(dir);
  if (bridge === null) {
    return { exitCode: 2, out: `no window to talk to: ${join(dir, 'agent-bridge.json')} does not exist (start the shell with --agent-port 0)\n` };
  }

  if (args.command === 'state') {
    const result = await bridgeCall(bridge, '/state');
    if (!result.ok) {
      return { exitCode: 1, out: `${result.body?.reason ?? `request failed (${result.status})`}\n` };
    }
    return { exitCode: 0, out: `${tabLines(result.body).join('\n')}\n` };
  }

  if (args.command === 'tabs') {
    const result = await bridgeCall(bridge, '/state');
    if (!result.ok) {
      return { exitCode: 1, out: `${result.body?.reason ?? `request failed (${result.status})`}\n` };
    }
    return { exitCode: 0, out: `${(result.body?.tabs ?? []).map((tab) => tab.id).join('\n')}\n` };
  }

  if (args.command === 'claim' || args.command === 'release') {
    const tabId = args.rest[0];
    if (!tabId) {
      return { exitCode: 1, out: `usage: ${args.command} <tabId>\n` };
    }
    const result = await bridgeCall(bridge, `/${args.command}`, { tabId, tier: args.tier, by: args.by });
    if (!result.ok) {
      return { exitCode: 1, out: `${result.body?.reason ?? `request failed (${result.status})`}\n` };
    }
    return { exitCode: 0, out: `${JSON.stringify(result.body)}\n` };
  }

  if (args.command === 'release-all') {
    const result = await bridgeCall(bridge, '/release-all', { by: args.by });
    if (!result.ok) {
      return { exitCode: 1, out: `${result.body?.reason ?? `request failed (${result.status})`}\n` };
    }
    return { exitCode: 0, out: `${JSON.stringify(result.body)}\n` };
  }

  return { exitCode: 1, out: `unknown command: ${args.command}\n` };
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const { exitCode, out } = await runBridgeCli(process.argv.slice(2));
  process.stdout.write(out);
  process.exit(exitCode);
}
