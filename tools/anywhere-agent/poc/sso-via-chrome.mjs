#!/usr/bin/env node
/**
 * Drives the sign-in in the user's own Chrome, over CDP.
 *
 * The client's sign-in is a browser hand-off: the app prints a PKCE link, a browser
 * completes it, and the loopback callback carries the code back. This script does
 * the browser half in the Chrome the user is already signed in to, where the
 * identity provider session lives - a fresh browser profile would only reach a login
 * form.
 *
 * Step one is always to look: it opens the link and reports what the page actually
 * offers before anything is clicked.
 *
 * Usage:
 *   node poc/sso-via-chrome.mjs --url <pkce-link> [--click <label>] [--shot <path>]
 */

import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { url: '', click: '', shot: join(HERE, 'evidence', 'sso-page.png'), waitMs: 25_000 };
  const values = ['--url', '--click', '--shot', '--wait-ms'];
  for (let i = 0; i < argv.length; i += 1) {
    if (values.includes(argv[i])) {
      const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[key] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.url === '') {
  process.stderr.write('--url is required\n');
  process.exit(2);
}
const out = (line) => process.stdout.write(`${line}\n`);

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = context.pages().find((candidate) => !candidate.isClosed()) ?? (await context.newPage());

out(`opened in the user's Chrome (${context.pages().length} page(s) already open)`);
await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(3_000);

out(`url=${page.url()}`);
out(`title=${await page.title()}`);

// What can be clicked: the point of looking before acting.
const controls = await page.evaluate(() => {
  const seen = [];
  for (const element of document.querySelectorAll('button, a, input[type=submit], [role=button]')) {
    const text = (element.innerText || element.value || element.getAttribute('aria-label') || '').trim();
    if (text === '') continue;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    seen.push(text.slice(0, 40));
  }
  return [...new Set(seen)];
});
out(`controls=${JSON.stringify(controls.slice(0, 20))}`);

const body = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 400);
out(`body=${body}`);

await page.screenshot({ path: args.shot });
out(`screenshot=${args.shot}`);

if (args.click !== '') {
  out(`clicking: ${args.click}`);
  // Searched across shadow roots and clicked in the page. Modern component
  // libraries render into shadow DOM, where a plain querySelectorAll never looks,
  // and the sign-in entry is a styled element rather than a control, so an
  // actionability-checked locator refuses it.
  const clicked = await page.evaluate((label) => {
    const walk = (root, found = []) => {
      for (const element of root.querySelectorAll('*')) {
        found.push(element);
        if (element.shadowRoot) {
          walk(element.shadowRoot, found);
        }
      }
      return found;
    };
    const all = walk(document);
    const describe = (element) => `${element.tagName}.${String(element.className).slice(0, 40)}`;
    const byText = all.filter((element) => (element.innerText || '').trim().includes(label));
    const byLabel = all.filter((element) => {
      const label2 = `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''} ${element.getAttribute('alt') ?? ''}`;
      return label2.includes(label);
    });
    const target = byText[0] ?? byLabel[0] ?? null;
    if (!target) {
      return {
        ok: false,
        textMatches: byText.length,
        labelMatches: byLabel.length,
        nearMisses: all
          .filter((element) => (element.innerText || '').includes('飞书'))
          .map(describe)
          .slice(0, 5),
      };
    }
    target.click();
    return { ok: true, target: describe(target), depth: all.length };
  }, args.click);
  out(`click result: ${JSON.stringify(clicked)}`);  await page.waitForTimeout(Number(args.waitMs));
  out(`after click url=${page.url()}`);
  out(`after click title=${await page.title()}`);
  await page.screenshot({ path: args.shot.replace('.png', '-after.png') });
  out(`after screenshot=${args.shot.replace('.png', '-after.png')}`);
}

browser.close();