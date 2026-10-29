#!/usr/bin/env node
/**
 * PoC probe: does a real Chromium render a DSH workspace through the loopback
 * overlay proxy, with the system resolver deliberately broken?
 *
 * The point of breaking the resolver is to prove the property the whole design
 * rests on: when the operating system cannot resolve `dsh.<machine>.netbird`, the
 * page must still load, because the client maps the name itself. A run that only
 * works because system DNS answered would prove nothing.
 *
 * The workspace socket matters as much as the page: Chromium tunnels `ws://`
 * through an HTTP proxy with CONNECT, so this run exercises both proxy paths
 * (absolute-form HTTP and CONNECT) and asserts the socket outlives more than two
 * 30-second heartbeat periods.
 *
 * Usage:
 *   node poc/browser-through-proxy.mjs --proxy http://127.0.0.1:19001 --authority dsh.peer-a.netbird --hold-ms 65000
 */

import { chromium } from 'playwright';

function parseArgs(argv) {
  const args = { proxy: 'http://127.0.0.1:19001', authority: '', holdMs: 65_000, breakDns: true, shot: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--proxy') args.proxy = value;
    else if (key === '--authority') args.authority = value;
    else if (key === '--hold-ms') args.holdMs = Number(value);
    else if (key === '--shot') args.shot = value;
    else if (key === '--keep-dns') args.breakDns = false;
    // A boolean flag must not consume the next argument: doing so swallowed the
    // following option (for example `--engine --dir X` lost the directory) and the
    // run then quietly used a default profile instead.
    if (!['--keep-dns'].includes(key)) i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.authority === '') {
  process.stderr.write('--authority is required\n');
  process.exit(2);
}

/** Break resolution for the entry name so only the proxy can serve the page. */
const hostResolverRules = args.breakDns ? `MAP ${args.authority} ~NOTFOUND` : `MAP ${args.authority} 127.0.0.1`;

const browser = await chromium.launch({
  headless: true,
  proxy: { server: args.proxy },
  args: [`--host-resolver-rules=${hostResolverRules}`, '--no-sandbox'],
});

const page = await browser.newPage();
const consoleErrors = [];
const pageErrors = [];
/** @type {Array<{ url: string, closed: string }>} */
const sockets = [];

page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(message.text().slice(0, 200));
  }
});
page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));
page.on('websocket', (socket) => {
  const record = { url: socket.url(), closed: '' };
  sockets.push(record);
  socket.on('close', () => {
    record.closed = 'closed';
  });
  socket.on('socketerror', (error) => {
    record.closed = `error: ${String(error).slice(0, 120)}`;
  });
});

process.stdout.write(`resolver rule: ${hostResolverRules}\n`);

const response = await page.goto(`http://${args.authority}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
process.stdout.write(`document status: ${response ? response.status() : 'none'}\n`);
await page.waitForTimeout(6_000);

const title = await page.title();
const bodyText = (await page.evaluate(() => document.body ? document.body.innerText.slice(0, 300) : '')).replace(/\s+/g, ' ');
process.stdout.write(`title: ${title}\n`);
process.stdout.write(`body: ${bodyText}\n`);
process.stdout.write(`sockets seen after load: ${sockets.length}\n`);
for (const socket of sockets) {
  process.stdout.write(`  ${socket.url}\n`);
}

await page.waitForTimeout(args.holdMs);

if (args.shot) {
  await page.screenshot({ path: args.shot, fullPage: false });
  process.stdout.write(`screenshot: ${args.shot}\n`);
}

const surviving = sockets.filter((socket) => socket.closed === '');
process.stdout.write(`sockets still open after ${args.holdMs} ms: ${surviving.length} of ${sockets.length}\n`);
for (const socket of sockets) {
  process.stdout.write(`  ${socket.closed === '' ? 'OPEN ' : 'CLOSED'} ${socket.url} ${socket.closed}\n`);
}
process.stdout.write(`console errors: ${consoleErrors.length}\n`);
for (const line of consoleErrors.slice(0, 5)) {
  process.stdout.write(`  ${line}\n`);
}
process.stdout.write(`page errors: ${pageErrors.length}\n`);
for (const line of pageErrors.slice(0, 5)) {
  process.stdout.write(`  ${line}\n`);
}

const passed = (response?.status() ?? 0) === 200 && surviving.length > 0 && pageErrors.length === 0;
process.stdout.write(passed ? 'RESULT pass\n' : 'RESULT fail\n');

await browser.close();
process.exit(passed ? 0 : 1);