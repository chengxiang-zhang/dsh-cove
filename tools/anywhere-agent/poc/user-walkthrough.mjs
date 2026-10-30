#!/usr/bin/env node
/**
 * User walkthrough: the journeys a person actually takes, driven in one real launch.
 *
 * This is not a unit check. It presses the same things a person presses - a card, the
 * plus button, a keyboard shortcut, the settings gear - and records what the window
 * looks like at each step. The service page is a native view, so it is captured from the
 * main process (`capturePage`) instead of the renderer screenshot, and both are written
 * beside each other.
 *
 * Scripted states: the machine's own entry points at the DSH that is already running on
 * this machine, so the walkthrough shows a real page rather than a fixture.
 *
 * Usage: node poc/user-walkthrough.mjs [--electron <path>] [--out <dir>]
 */

import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = join(HERE, '..', 'shell');
const FIXTURE = pathToFileURL(join(HERE, 'fixtures', 'blank.html')).href;
const DSH = process.env.AW_DSH_URL ?? 'http://127.0.0.1:3080/';

function parseArgs(argv) {
  const args = { electron: process.env.AW_ELECTRON ?? '', out: join(HERE, 'evidence', 'walkthrough') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--electron') {
      args.electron = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--out') {
      args.out = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.out, { recursive: true });
writeFileSync(
  join(HERE, 'fixtures', 'blank.html'),
  '<!doctype html><meta charset="utf-8"><title>Machine Workspace</title><h1 id="ok">workspace</h1>',
  'utf8',
);

// Two web services: one that answers, one that does not (the error page needs a failure
// that is the service's fault, not the harness's).
const site = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(
    '<!doctype html><meta charset="utf-8"><title>Wiki</title><style>body{font:14px/1.6 -apple-system;padding:40px;color:#0f172a}h1{font-size:20px}</style><h1>团队 Wiki</h1><p>这是一个内网服务页面，由本地 http 服务提供。</p>',
  );
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const SITE_URL = `http://127.0.0.1:${site.address().port}/`;

const ENTRY = (machine, url) => ({ host: `dsh.${machine}.netbird`, machine, ip: '100.64.1.10', url, statusCode: 200 });
const SNAPSHOTS = {
  ready: {
    local: { state: 'ready', detail: '', machine: 'studio-mac', host: 'dsh.studio-mac.netbird', url: DSH },
    fleet: { state: 'ready', detail: '' },
    engine: { protocol: 1, helper: '0.1.1', netbird: 'v0.78.1' },
    self: { machine: 'studio-mac', ip: '100.64.1.10', interfaceType: 'Userspace', host: 'dsh.studio-mac.netbird' },
    kernel: { installed: true, version: '0.2.0-rc.2', reachable: true, service: { label: 'org.dsh.web', loaded: true } },
    registered: 3,
    app: { version: '0.4.10', build: '118' },
    server: { line: 'netbird.example.com', hasUrl: true },
    entries: [
      { ...ENTRY('studio-mac', DSH), local: true },
      ENTRY('tower-lab', FIXTURE),
      { ...ENTRY('imac-office', FIXTURE), statusCode: 302 },
    ],
  },
};

SNAPSHOTS.offline = {
  ...SNAPSHOTS.ready,
  state: 'error',
  fleet: { state: 'error', detail: '连不上' },
  detail: '私网连接断开了',
  entries: [],
  registered: 0,
};
const statesFile = join(args.out, 'states.json');
writeFileSync(statesFile, JSON.stringify(SNAPSHOTS, null, 2), 'utf8');
writeFileSync(
  join(args.out, 'services.json'),
  JSON.stringify(
    {
      services: [
        { id: 'web:wiki', name: 'Wiki', subtitle: '团队文档', url: SITE_URL },
        { id: 'web:broken', name: '打不开的服务', subtitle: '已经下线', url: 'http://127.0.0.1:9/' },
      ],
    },
    null,
    2,
  ),
  'utf8',
);

const userData = join(args.out, 'userdata');
rmSync(userData, { recursive: true, force: true });
mkdirSync(userData, { recursive: true });

const log = createWriteStream(join(args.out, 'app-stderr.log'));
const app = await electron.launch({
  executablePath: args.electron,
  args: [
    `--user-data-dir=${userData}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-sandbox',
    SHELL_DIR,
    '--states',
    statesFile,
    '--services',
    join(args.out, 'services.json'),
    '--dir',
    userData,
  ],
  colorScheme: 'light',
});

const notes = [];
const step = (index, title) => process.stdout.write(`\n[${index}] ${title}\n`);
const shot = async (page, name) => {
  await page.screenshot({ path: join(args.out, `${name}-window.png`) });
  const native = await app.evaluate(async () => {
    const view = globalThis.__awWorkspace;
    if (!view) {
      return '';
    }
    const image = await view.webContents.capturePage();
    return image.toPNG().toString('base64');
  });
  if (native) {
    writeFileSync(join(args.out, `${name}-page.png`), Buffer.from(native, 'base64'));
  }
  process.stdout.write(`    saved ${name}-window.png${native ? ` + ${name}-page.png` : ''}\n`);
};

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => window.anywhere.refresh('ready'));
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 1, null, { timeout: 15_000 });

  // 1. What a person sees first.
  step(1, 'first launch: the home');
  const cards = await page.locator('.card').count();
  notes.push(`首屏卡片数 ${cards}`);
  await shot(page, '01-home');

  // 2. Open the machine they are already on (a real DSH page).
  step(2, 'open my own machine');
  await page.click('.card[data-service-id^="machine:dsh.studio-mac"]');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 2, null, { timeout: 20_000 });
  await page.waitForTimeout(1500);
  const dshUrl = await app.evaluate(() => globalThis.__awWorkspace?.webContents.getURL() ?? '');
  notes.push(`本机页签加载 ${dshUrl}`);
  await shot(page, '02-machine');

  // 3. Go back to the home from the tab strip, then open a web service.
  step(3, 'back to the home, open an intranet service');
  await page.click('.tab[data-tab-id="home"]');
  await page.waitForFunction(() => !document.getElementById('home')?.hidden, null, { timeout: 10_000 });
  await page.click('.card[data-service-id="web:wiki"]');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 3, null, { timeout: 20_000 });
  await page.waitForTimeout(1200);
  const wikiUrl = await app.evaluate(() => globalThis.__awWorkspace?.webContents.getURL() ?? '');
  notes.push(`内网服务页签加载 ${wikiUrl}`);
  await shot(page, '03-web-service');

  // 4. Switch tabs with the keyboard, the way a heavy user does.
  step(4, 'keyboard: switch to the machine tab');
  await page.keyboard.press('Meta+1');
  await page.waitForTimeout(700);
  const activeAfterKey = await page.locator('.tab[data-active="true"] .tab-title').innerText();
  notes.push(`⌘1 之后激活的是「${activeAfterKey}」`);
  await shot(page, '04-switch');

  // 4b. Reorder by dragging, the way a person tidies their tabs.
  step('4b', 'drag a tab to reorder');
  const orderBefore = await page.locator('.tab .tab-title').allInnerTexts();
  await page.dragAndDrop('.tab[data-tab-id^="svc:web:wiki"]', '.tab[data-tab-id^="svc:machine:"]');
  await page.waitForTimeout(800);
  const orderAfter = await page.locator('.tab .tab-title').allInnerTexts();
  notes.push(`拖拽前 [${orderBefore.join(' | ')}] → 后 [${orderAfter.join(' | ')}]`);
  await shot(page, '04b-reorder');

  // 5. The palette, which is the only "address bar" this window has.
  step(5, 'command palette');
  await page.keyboard.press('Meta+k');
  await page.waitForFunction(() => !document.getElementById('palette')?.hidden, null, { timeout: 10_000 });
  await page.fill('#palette-input', 'wiki');
  await page.waitForTimeout(400);
  const paletteHits = await page.locator('.palette-item').count();
  notes.push(`⌘K 输入 wiki 命中 ${paletteHits} 条`);
  await shot(page, '05-palette');
  await page.keyboard.press('Escape');

  // 6. Settings: every group is a click away, and the diagnostics are here now.
  step(6, 'settings');
  await page.click('#open-settings');
  await page.waitForFunction(() => !document.getElementById('settings')?.hidden, null, { timeout: 10_000 });
  const groups = await page.locator('.settings-nav button').count();
  notes.push(`设置分组 ${groups} 个`);
  await shot(page, '06-settings');
  await page.click('.settings-nav button[data-section="tabs"]');
  await page.waitForTimeout(300);
  await shot(page, '07-settings-tabs');

  // 7. A service that is down: the failure has to stay inside its own tab.
  step(7, 'a service that does not answer');
  await page.click('.tab[data-tab-id="home"]');
  await page.waitForFunction(() => !document.getElementById('home')?.hidden, null, { timeout: 10_000 });
  await page.click('.card[data-service-id="web:broken"]');
  await page.waitForTimeout(3500);
  const errorVisible = await page.locator('#message').isVisible();
  notes.push(`打不开的服务 → 错误页 ${errorVisible ? '出现' : '没有出现'}`);
  await shot(page, '08-error');

  // 8. Close everything: the window must come back to the home, not close.
  step(8, 'close the tabs');
  for (let i = 0; i < 6; i += 1) {
    const open = await page.locator('.tab').count();
    if (open <= 1) {
      break;
    }
    await page.click('.tab[data-active="true"] .tab-close');
    await page.waitForTimeout(700);
  }
  notes.push(`关到最后剩 ${await page.locator('.tab').count()} 个页签`);
  await shot(page, '09-home-again');

  // 9. A narrow window, the way it looks docked beside an editor.
  step(9, 'narrow window');
  await page.setViewportSize({ width: 640, height: 620 });
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  notes.push(`640px 横向溢出：${overflow ? '有' : '无'}`);
  await shot(page, '10-narrow');

  // 9b. The two states the spec names but a happy path never reaches: 320px, and a
  // disconnected fleet (the home must keep its cards instead of emptying out).
  step('9b', '320px and a disconnected home');
  await page.click('.tab[data-tab-id="home"]');
  await page.waitForFunction(() => !document.getElementById('home')?.hidden, null, { timeout: 10_000 });
  await page.setViewportSize({ width: 320, height: 600 });
  await page.waitForTimeout(400);
  const overflow320 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  notes.push(`320px 横向溢出：${overflow320 ? '有' : '无'}`);
  await shot(page, '09b-narrow-320');
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.evaluate(() => window.anywhere.refresh('offline'));
  await page.waitForTimeout(1200);
  const cardsOffline = await page.locator('.card').count();
  notes.push(`断网后首页卡片数：${cardsOffline}`);
  await shot(page, '09c-offline-home');

  // 9d. Dark scheme: the token sheet follows prefers-color-scheme, so this is the same
  // switch the operating system throws.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(500);
  await shot(page, '09d-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // 10. Every other group of settings still renders (no dead panes).
  step(10, 'the rest of the settings groups');
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.click('#open-settings');
  await page.waitForFunction(() => !document.getElementById('settings')?.hidden, null, { timeout: 10_000 });
  const seen = [];
  for (const key of ['appearance', 'services', 'about', 'network']) {
    await page.click(`.settings-nav button[data-section="${key}"]`);
    await page.waitForTimeout(250);
    seen.push(`${key}:${await page.locator('#settings .row').count()}行`);
  }
  notes.push(`设置各分组 ${seen.join(' ')}`);
  await shot(page, '11-settings-all');
} finally {
  await app.close();
  log.end();
  site.close();
}

process.stdout.write(`\nwalkthrough notes:\n${notes.map((note) => ` - ${note}`).join('\n')}\n`);
process.stdout.write(`\nartifacts in ${args.out}\n`);
