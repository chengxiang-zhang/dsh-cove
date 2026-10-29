#!/usr/bin/env node
/**
 * PoC: run the embedded engine app-scoped and hand out its loopback proxy.
 *
 * This is the shape the desktop client ships: one process holds the overlay
 * engine (userspace netstack, private config/state), one loopback proxy is the
 * only door into the private network, and the operating system is never touched.
 *
 * The name-to-address table comes from the engine's own network map: the DSH
 * entries it accepted, each one already checked against the overlay addresses of
 * this network. The system resolver is not consulted anywhere.
 *
 * Usage:
 *   node poc/embedded-engine.mjs [--dir <private state dir>] [--hold-ms 300000]
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { TunnelClient } from '../src/tunnel-client.mjs';
import { buildRegistry, peerAddressSet } from '../src/discovery.mjs';
import { createPeerResolver } from '../src/netbird-status.mjs';
import { startOverlayProxy } from '../src/overlay-proxy.mjs';

function parseArgs(argv) {
  const args = {
    binary: join(homedir(), '.cache/anywhere-agent/bin/anywhere-tunnel'),
    dir: join(homedir(), '.anywhere-poc'),
    managementUrl: 'https://netbird.example.com:443',
    deviceName: 'anywhere-poc',
    zones: ['netbird'],
    port: 19002,
    holdMs: 600_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--binary') args.binary = value;
    else if (key === '--dir') args.dir = value;
    else if (key === '--management-url') args.managementUrl = value;
    else if (key === '--device-name') args.deviceName = value;
    else if (key === '--zones') args.zones = String(value).split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === '--port') args.port = Number(value);
    else if (key === '--hold-ms') args.holdMs = Number(value);
    if (key.startsWith('--')) i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.dir, { recursive: true, mode: 0o700 });
const configPath = join(args.dir, 'config.json');
const statePath = join(args.dir, 'state.json');
const out = (line) => process.stdout.write(`${line}\n`);

const client = new TunnelClient({
  binary: args.binary,
  onStderr: (line) => process.stderr.write(`[engine] ${line}\n`),
});
client.start();

out(`engine=${JSON.stringify(await client.version())}`);

await client.request('start', {
  setupKey: '',
  deviceName: args.deviceName,
  managementUrl: args.managementUrl,
  configPath,
  statePath,
});

// The engine registers and receives its network map asynchronously; the
// management link is the honest readiness signal, not a fixed sleep.
let status = null;
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  try {
    status = await client.request('status');
    if (status && status.managementConnected) {
      break;
    }
  } catch (error) {
    out(`status error: ${error.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
out(`status=${JSON.stringify(status)}`);

// The network map arrives after the management link does: a peer that is
// connected but not yet mapped reports zero peers and zero records. The mobile
// client waits this window out too (CATALOGUE_SETTLE_TIMEOUT_MS), because
// reporting an empty machine list on a cold start is the failure users notice.
let rawPeers = [];
let rawServices = [];
const settleDeadline = Date.now() + 25_000;
while (Date.now() < settleDeadline) {
  rawPeers = await client.request('peers');
  rawServices = await client.request('services');
  const peerCount = Array.isArray(rawPeers) ? rawPeers.length : 0;
  const recordCount = Array.isArray(rawServices) ? rawServices.length : 0;
  if (peerCount > 0 || recordCount > 0) {
    out(`map arrived after ${Math.round((25_000 - (settleDeadline - Date.now())) / 1000)}s: peers=${peerCount} records=${recordCount}`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}

const peerAddresses = peerAddressSet(
  (Array.isArray(rawPeers) ? rawPeers : []).map((address) => ({ ip: String(address) })),
);
out(`peerAddresses=${peerAddresses.length} ${JSON.stringify(peerAddresses.slice(0, 4))}`);

const records = (Array.isArray(rawServices) ? rawServices : []).filter((record) => record && record.name);
const registry = buildRegistry(records, peerAddresses, args.zones);
out(`dnsRecords=${records.length} acceptedEntries=${registry.entries.length} rejected=${registry.rejected}`);
for (const entry of registry.entries) {
  out(`  entry ${entry.host} -> ${entry.ip}`);
}

if (registry.entries.length === 0) {
  // An empty map is a fleet-side visibility fact, not an engine failure: a peer
  // in no policy is handed no peers at all, and without peers no DSH name can be
  // accepted. The engine stays up so the app-scope audit can run against it.
  out('NO_ENTRIES: the engine sees no machine of this network (peer is in no policy)');
  const idleProxy = await startOverlayProxy({
    resolve: () => null,
    port: args.port,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  out(`PROXY=${idleProxy.url} (refuses every name until the map arrives)`);
  out('HOLDING — the engine is live; kill this process to withdraw the overlay.');
  const stopIdle = async () => {
    await idleProxy.close();
    await client.stop();
    process.exit(0);
  };
  process.on('SIGTERM', stopIdle);
  process.on('SIGINT', stopIdle);
  await new Promise((resolve) => setTimeout(resolve, args.holdMs));
  await stopIdle();
  process.exit(0);
}

// The overlay's own table: every accepted entry is reachable by the address the
// engine reports, so the proxy never needs a resolver.
const resolve = createPeerResolver({
  self: { machine: '', ip: '' },
  peers: registry.entries.map((entry) => ({ name: entry.machine, ip: entry.ip })),
  zones: args.zones,
});

const proxy = await startOverlayProxy({
  resolve,
  port: args.port,
  log: (line) => process.stderr.write(`${line}\n`),
});
out(`PROXY=${proxy.url}`);
out('HOLDING — the engine is live; kill this process to withdraw the overlay.');

const report = () => out(`proxyStats=${JSON.stringify(proxy.stats())}`);
const ticker = setInterval(report, 15_000);

const shutdown = async () => {
  clearInterval(ticker);
  report();
  await proxy.close();
  await client.stop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await new Promise((resolve) => setTimeout(resolve, args.holdMs));
await shutdown();