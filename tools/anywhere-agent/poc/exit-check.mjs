#!/usr/bin/env node
/**
 * PoC: does the office exit apply to app-scoped traffic?
 *
 * The fleet routes a curated set of overseas domains through the office's public
 * egress (the `sci-exit` group). The open question is whether that exit also
 * applies when the overlay runs inside the app as a userspace netstack, which is
 * the shape this client ships.
 *
 * The probe asks a routed domain to report the address it saw the request come
 * from: cloudflare.com is on the routed list, and its trace endpoint echoes the
 * egress address. The same probe is run before and after joining the group, so
 * the answer is a comparison rather than an interpretation.
 *
 * Usage:
 *   node poc/exit-check.mjs --label before
 */

import { mkdirSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { TunnelClient } from '../src/tunnel-client.mjs';

function parseArgs(argv) {
  const args = {
    binary: join(homedir(), '.cache/anywhere-agent/bin/anywhere-tunnel'),
    dir: join(homedir(), '.anywhere-poc'),
    managementUrl: 'https://netbird.example.com:443',
    deviceName: 'anywhere-poc',
    label: 'run',
    url: 'https://www.cloudflare.com/cdn-cgi/trace',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--binary') args.binary = value;
    else if (key === '--dir') args.dir = value;
    else if (key === '--label') args.label = value;
    else if (key === '--url') args.url = value;
    else if (key === '--management-url') args.managementUrl = value;
    else if (key === '--device-name') args.deviceName = value;
    if (key.startsWith('--')) i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.dir, { recursive: true, mode: 0o700 });
const out = (line) => process.stdout.write(`${line}\n`);

const client = new TunnelClient({
  binary: args.binary,
  onStderr: (line) => {
    if (/route|exit|network map|engine started|Netbird engine started/i.test(line)) {
      process.stderr.write(`[engine] ${line}\n`);
    }
  },
});
client.start();

await client.request('start', {
  setupKey: '',
  deviceName: args.deviceName,
  managementUrl: args.managementUrl,
  configPath: join(args.dir, 'config.json'),
  statePath: join(args.dir, 'state.json'),
});

// Wait for the map, then give the netstack a moment to finish applying it.
let peers = [];
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  try {
    peers = await client.request('peers');
    if (Array.isArray(peers) && peers.length > 0) {
      break;
    }
  } catch {
    // The engine reports failure until the map exists; keep waiting.
  }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}
out(`${args.label}: peers=${Array.isArray(peers) ? peers.length : 0}`);
await new Promise((resolve) => setTimeout(resolve, 5_000));

let body = '';
try {
  // The netstack's own resolver answers only the fleet's zones, so the app
  // resolves the public name itself and hands the address to the engine. The
  // engine still decides which route carries the request - that is the question
  // this probe answers.
  const hostname = new URL(args.url).hostname;
  const { address } = await lookup(hostname, { family: 4 });
  out(`${args.label}: resolved ${hostname} -> ${address} (system resolver, app-side)`);
  body = String(await client.request('fetch-static', { url: args.url, address, host: hostname }));
} catch (error) {
  out(`${args.label}: fetch failed: ${error.message}`);
}

const fields = {};
for (const line of body.split('\n')) {
  const index = line.indexOf('=');
  if (index > 0) {
    fields[line.slice(0, index)] = line.slice(index + 1);
  }
}
out(`${args.label}: egressIp=${fields.ip ?? '(none)'} colo=${fields.colo ?? '-'} loc=${fields.loc ?? '-'} warp=${fields.warp ?? '-'}`);

await client.stop();