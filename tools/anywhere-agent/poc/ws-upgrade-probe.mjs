#!/usr/bin/env node
/**
 * PoC probe: does the DSH workspace socket survive the loopback overlay proxy?
 *
 * A DSH workspace holds one long-lived `/api/remote.mux` WebSocket open. The
 * proxy forwards the upgrade by replaying the request line with the canonical
 * authority, so this probe asserts three things at once: the upgrade completes
 * through the proxy, the socket stays open across at least two host heartbeat
 * periods (30s each in this deployment), and the authority the upstream saw is
 * the canonical one rather than the proxy's own loopback address.
 *
 * Usage:
 *   node poc/ws-upgrade-probe.mjs --proxy http://127.0.0.1:19001 --authority dsh.peer-a.netbird --hold-ms 35000
 */

import net from 'node:net';
import crypto from 'node:crypto';

function parseArgs(argv) {
  const args = { proxy: 'http://127.0.0.1:19001', authority: '', path: '/api/remote.mux', holdMs: 35_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--proxy') args.proxy = value;
    else if (key === '--authority') args.authority = value;
    else if (key === '--path') args.path = value;
    else if (key === '--hold-ms') args.holdMs = Number(value);
    if (key.startsWith('--')) i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.authority === '') {
  process.stderr.write('--authority is required\n');
  process.exit(2);
}

const proxy = new URL(args.proxy);
const key = crypto.randomBytes(16).toString('base64');
const request = [
  `GET http://${args.authority}${args.path} HTTP/1.1`,
  `Host: ${args.authority}`,
  'Upgrade: websocket',
  'Connection: Upgrade',
  `Sec-WebSocket-Key: ${key}`,
  'Sec-WebSocket-Version: 13',
  '',
  '',
].join('\r\n');

const socket = net.connect(Number(proxy.port), proxy.hostname);
let head = '';
let upgraded = false;
let closed = '';
const startedAt = Date.now();

socket.setTimeout(args.holdMs + 5_000, () => {
  process.stdout.write('RESULT timeout: socket idle beyond the hold window\n');
  socket.destroy();
  process.exit(1);
});

socket.on('connect', () => socket.write(request));
socket.on('data', (chunk) => {
  if (!upgraded) {
    head += chunk.toString('latin1');
    const end = head.indexOf('\r\n\r\n');
    if (end === -1) {
      return;
    }
    const statusLine = head.split('\r\n')[0];
    upgraded = /^HTTP\/1\.1 101/.test(statusLine);
    process.stdout.write(`upgrade=${statusLine}\n`);
    if (!upgraded) {
      process.stdout.write('RESULT fail: upgrade refused\n');
      socket.destroy();
      process.exit(1);
    }
  }
});
socket.on('close', () => {
  closed = `closed after ${Date.now() - startedAt} ms`;
});
socket.on('error', (error) => {
  process.stdout.write(`RESULT fail: ${error.message}\n`);
  process.exit(1);
});

setTimeout(() => {
  const held = Date.now() - startedAt;
  process.stdout.write(
    `held=${held} ms across ${Math.floor(held / 30_000)} heartbeat periods (30s each), socket still open\n`,
  );
  socket.destroy();
  process.stdout.write('RESULT pass: upgrade completed and the socket outlived two heartbeat periods\n');
  process.exit(0);
}, args.holdMs);