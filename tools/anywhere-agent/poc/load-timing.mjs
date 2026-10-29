#!/usr/bin/env node
/**
 * PoC measurement: where does the wait between opening an entry and a usable
 * workspace actually go?
 *
 * Three phases are measured against the same machine, because they answer three
 * different questions:
 *
 *   cold  - first ever load in a fresh profile: what the user pays on day one
 *   warm  - reload in the same profile: what a resident shell pays when assets
 *           could come from cache
 *   fresh - a second tab in the same profile: what switching between machines
 *           costs once the shell process is already running
 *
 * Two milestones are reported separately, because they are different costs:
 * `plugins` is the host finishing its plugin boot (the "Loading plugins" wait),
 * `composer` is the workspace actually being usable.
 *
 * Usage:
 *   node poc/load-timing.mjs --proxy http://127.0.0.1:19001 --authority dsh.peer-a.netbird
 */

import { chromium } from 'playwright';
import { rmSync } from 'node:fs';

function parseArgs(argv) {
  const args = { proxy: 'http://127.0.0.1:19001', authority: '', profile: '', breakDns: true, budgetMs: 45_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--proxy') args.proxy = value;
    else if (key === '--authority') args.authority = value;
    else if (key === '--profile') args.profile = value;
    else if (key === '--budget-ms') args.budgetMs = Number(value);
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

const url = `http://${args.authority}/`;
const profile = args.profile === '' ? `/tmp/anywhere-timing-${args.authority.replace(/\./g, '-')}` : args.profile;
const hostResolverRules = args.breakDns ? `MAP ${args.authority} ~NOTFOUND` : `MAP ${args.authority} 127.0.0.1`;

/** The host finished activating plugins: the splash text is gone. */
const PLUGINS_DONE = () => !(document.body ? document.body.innerText : '').includes('Loading plugins');
/** The workspace is usable: a composer exists (textarea or contenteditable). */
const COMPOSER_READY = () => !!document.querySelector('textarea, [contenteditable="true"]');

/** Waits for a predicate and returns ms since t0, or -1 when it never held. */
async function milestone(page, predicate, t0, budgetMs) {
  try {
    await page.waitForFunction(predicate, null, { timeout: budgetMs, polling: 200 });
    return Date.now() - t0;
  } catch {
    return -1;
  }
}

/**
 * Loads the entry once and reports the milestones.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} label
 */
async function measure(context, label) {
  const page = await context.newPage();
  /** @type {Array<{ url: string, ms: number, bytes: number, status: number }>} */
  const requests = [];
  const began = new Map();
  let socketMs = -1;
  const t0 = Date.now();

  page.on('request', (request) => began.set(request, Date.now()));
  page.on('requestfinished', async (request) => {
    const start = began.get(request);
    if (start === undefined) {
      return;
    }
    let bytes = 0;
    try {
      const sizes = await request.sizes();
      bytes = sizes.responseBodySize ?? 0;
    } catch {
      // A request that never completed has no sizes; zero is honest here.
    }
    let status = 0;
    try {
      status = (await request.response())?.status() ?? 0;
    } catch {
      status = 0;
    }
    requests.push({ url: request.url(), ms: Date.now() - start, bytes, status });
  });
  page.on('websocket', () => {
    if (socketMs === -1) {
      socketMs = Date.now() - t0;
    }
  });

  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: args.budgetMs });
  const tDom = Date.now() - t0;
  const tPlugins = await milestone(page, PLUGINS_DONE, t0, args.budgetMs);
  const tComposer = await milestone(page, COMPOSER_READY, t0, args.budgetMs);
  await page.waitForTimeout(2_000);

  const totalBytes = requests.reduce((sum, entry) => sum + entry.bytes, 0);
  const slowest = [...requests].sort((a, b) => b.ms - a.ms).slice(0, 4);
  const fmt = (value) => (value === -1 ? 'TIMEOUT' : `${value}ms`);
  process.stdout.write(
    `[${label}] status=${response ? response.status() : 'none'} dom=${tDom}ms plugins=${fmt(tPlugins)} composer=${fmt(tComposer)} socket=${socketMs === -1 ? 'none' : `${socketMs}ms`} reqs=${requests.length} bytes=${totalBytes}\n`,
  );
  for (const entry of slowest) {
    const path = entry.url.replace(`http://${args.authority}`, '');
    process.stdout.write(
      `    slow ${String(entry.ms).padStart(5)}ms ${String(entry.bytes).padStart(8)}B ${entry.status} ${path.slice(0, 80)}\n`,
    );
  }
  await page.close();
  return { tDom, tPlugins, tComposer, socketMs, requests: requests.length, bytes: totalBytes };
}

rmSync(profile, { recursive: true, force: true });

const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  proxy: { server: args.proxy },
  args: [`--host-resolver-rules=${hostResolverRules}`, '--no-sandbox'],
});

process.stdout.write(`authority=${args.authority} resolver=${hostResolverRules}\n`);
const cold = await measure(context, 'cold ');
const warm = await measure(context, 'warm ');
const fresh = await measure(context, 'fresh');

process.stdout.write(
  `summary ${args.authority}: cold(plugins=${cold.tPlugins} composer=${cold.tComposer} bytes=${cold.bytes}) warm(plugins=${warm.tPlugins} composer=${warm.tComposer} bytes=${warm.bytes}) fresh(plugins=${fresh.tPlugins} composer=${fresh.tComposer} bytes=${fresh.bytes})\n`,
);

await context.close();