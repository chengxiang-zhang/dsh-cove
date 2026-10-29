#!/usr/bin/env node
/**
 * PoC entry point: start the loopback overlay proxy in front of one DSH entry.
 *
 * It reads the engine's own status (never the system resolver), builds the
 * name-to-overlay-address table, and listens on loopback. Point a browser shell
 * at the printed URL and every canonical entry name resolves inside this process.
 *
 * Usage:
 *   node bin/anywhere-proxy.mjs [--port 19001] [--netbird /opt/homebrew/bin/netbird]
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { startOverlayProxy } from '../src/overlay-proxy.mjs';
import { createPeerResolver, parsePeers, parseSelfStatus } from '../src/netbird-status.mjs';

const run = promisify(execFile);

/** Finds the engine binary: PATH first, then the two usual install locations. */
function findNetbird(explicit) {
  if (explicit) {
    return explicit;
  }
  for (const candidate of ['/usr/local/bin/netbird', '/opt/homebrew/bin/netbird']) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return 'netbird';
}

function parseArgs(argv) {
  const args = { port: 19001, netbird: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') {
      args.port = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--netbird') {
      args.netbird = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

/** Reads engine status through the binary, bounded so the PoC cannot hang. */
async function readStatus(binary, extra) {
  const { stdout } = await run(binary, ['status', ...extra], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

const args = parseArgs(process.argv.slice(2));
const binary = findNetbird(args.netbird);

const self = parseSelfStatus(await readStatus(binary, []));
const peers = parsePeers(await readStatus(binary, ['-d']));
const resolve = createPeerResolver({ self, peers, zones: ['netbird'] });

process.stdout.write(
  `engine=${binary}\nself=${self.machine || '(unknown)'} ip=${self.ip || '(unknown)'} interface=${self.interfaceType || '(unknown)'}\npeers=${peers.length}\n`,
);
for (const peer of peers) {
  process.stdout.write(`  ${peer.name} -> ${peer.ip || '(no address)'} [${peer.status || 'unknown'}]\n`);
}

const proxy = await startOverlayProxy({
  resolve,
  port: args.port,
  log: (message) => process.stderr.write(`${message}\n`),
});
process.stdout.write(`proxy=${proxy.url}\n`);
process.stdout.write(`try: curl -x ${proxy.url} http://dsh.<machine>.netbird/\n`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    proxy.close().then(() => process.exit(0));
  });
}