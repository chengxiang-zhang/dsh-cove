#!/usr/bin/env node
/**
 * Window geometry check: the page follows the window, whichever way the window changes.
 *
 * A service page is a native `WebContentsView` painted above the renderer, so its size is
 * not a CSS property that reflows - it is a placement the renderer has to report. Every
 * defect in this area looks the same to a person: the page keeps the size it had, and only
 * a tab switch (which happens to re-render) catches it up.
 *
 * This run drives the real window and asserts the placement against the real content area,
 * in both directions of a resize, at a zoom level, in full screen, and while an overlay is
 * up. The page's own `innerWidth` is read from inside the embedded page: that is the thing
 * the person actually sees, and it cannot be satisfied by moving bounds alone.
 *
 * The states are scripted, so the run touches nothing on this machine: no engine is
 * started, no network is dialled.
 *
 * Usage:
 *   node poc/resize-contract.mjs [--electron <path>] [--out <dir>] [--packaged]
 *
 * `--packaged` runs a built bundle instead of the source tree: Electron ignores an app
 * directory argument for a packaged app, so the argument is left out and the bundle's own
 * payload is what gets exercised. Use it to verify the artifact a person will actually
 * launch, not just the checkout.
 */

import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_DIR = join(HERE, '..', 'shell');

function parseArgs(argv) {
  const args = { electron: process.env.AW_ELECTRON ?? '', out: join(HERE, 'evidence', 'resize'), packaged: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--electron') {
      args.electron = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--out') {
      args.out = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--packaged') {
      args.packaged = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.out, { recursive: true });

// The served page reports its own viewport, so "the page reflowed" is a fact and not an
// inference from the native view's bounds.
const site = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><meta charset="utf-8"><title>Workspace</title>
<style>html,body{margin:0;height:100%;font:14px -apple-system}main{padding:24px}</style>
<main>
  <h1 id="workspace">workspace</h1>
  <p id="size"></p>
</main>
<script>
  const report = () => {
    document.getElementById('size').textContent = innerWidth + 'x' + innerHeight;
  };
  addEventListener('resize', report);
  report();
</script>`);
});
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
const SITE_URL = `http://127.0.0.1:${site.address().port}/`;

const ENGINE = { protocol: 1, helper: '0.1.1', netbird: 'v0.78.1' };
const KERNEL = { installed: true, version: '0.2.0-rc.2', reachable: true, service: { label: 'org.dsh.web', loaded: true } };
const states = {
  ready: {
    local: { state: 'ready', detail: '', machine: 'studio-mac', host: 'dsh.studio-mac.netbird', url: SITE_URL },
    fleet: { state: 'ready', detail: 'fleet ready' },
    engine: ENGINE,
    self: { machine: 'studio-mac', ip: '100.64.1.10', interfaceType: 'Userspace', host: 'dsh.studio-mac.netbird' },
    kernel: KERNEL,
    registered: 1,
    app: { version: '0.4.10', build: '118' },
    server: { line: 'netbird.example.com', hasUrl: true },
    entries: [
      { host: 'dsh.studio-mac.netbird', machine: 'studio-mac', ip: '100.64.1.10', url: SITE_URL, statusCode: 200, local: true },
      { host: 'dsh.tower-lab.netbird', machine: 'tower-lab', ip: '100.64.1.11', url: SITE_URL, statusCode: 200 },
    ],
  },
};
const statesFile = join(args.out, 'states.json');
writeFileSync(statesFile, JSON.stringify(states, null, 2), 'utf8');

const userData = join(args.out, 'userdata');
mkdirSync(userData, { recursive: true });
rmSync(join(userData, 'tabs.json'), { force: true });
const servicesFile = join(args.out, 'services.json');
writeFileSync(servicesFile, JSON.stringify({ services: [] }, null, 2), 'utf8');

const stderrLog = createWriteStream(join(args.out, 'app-stderr.log'));

let failures = 0;
function check(name, ok, detail) {
  if (!ok) {
    failures += 1;
    process.stdout.write(`  FAIL ${name}${detail === undefined ? '' : `: ${detail}`}\n`);
    return;
  }
  process.stdout.write(`  ok   ${name}\n`);
}

const near = (actual, expected, tolerance = 1) => Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;

/** Waits for the embedded page to exist in the main process, where the view lives. */
async function waitForPageLoaded(timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const url = await app.evaluate(() => globalThis.__awWorkspace?.webContents.getURL() ?? '');
    if (url !== '') {
      return url;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the embedded page never appeared in the main process');
}

/** What the window, the native page and the renderer each believe right now. */
async function readGeometry(page) {
  const native = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const view = globalThis.__awWorkspace;
    const content = win.getContentBounds();
    return {
      content: { width: content.width, height: content.height },
      bounds: view ? view.getBounds() : null,
      visible: view ? view.getVisible() : null,
      zoom: win.webContents.getZoomFactor(),
      // The embedded page has its own zoom: the shell's zoom changes the exchange rate
      // between its CSS pixels and DIP, it does not scale the page inside the view.
      pageZoom: view ? view.webContents.getZoomFactor() : 1,
      url: view ? view.webContents.getURL() : '',
    };
  });
  const area = await page.evaluate(() => {
    const rect = document.getElementById('page').getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const inner = await app.evaluate(async () => {
    const view = globalThis.__awWorkspace;
    if (!view) {
      return null;
    }
    return view.webContents.executeJavaScript('({ width: innerWidth, height: innerHeight })');
  });
  return { ...native, area, inner };
}

/** Saves what the embedded page itself looks like, which a renderer screenshot cannot see. */
async function capturePage(name) {
  const png = await app.evaluate(async () => {
    const view = globalThis.__awWorkspace;
    const image = await view.webContents.capturePage();
    return image.toPNG().toString('base64');
  });
  writeFileSync(join(args.out, name), Buffer.from(png, 'base64'));
}

/** The placement the reported page area implies, in DIP. */
function expectedBounds(geometry) {
  const { area, zoom, content } = geometry;
  const scale = zoom > 0 ? zoom : 1;
  return {
    x: Math.round(area.x * scale),
    y: Math.round(area.y * scale),
    width: Math.min(Math.round(area.width * scale), content.width),
    height: Math.min(Math.round(area.height * scale), content.height - Math.round(area.y * scale)),
  };
}

function checkPlacement(name, geometry) {
  const expected = expectedBounds(geometry);
  const bounds = geometry.bounds;
  const matches =
    bounds !== null &&
    near(bounds.x, expected.x) &&
    near(bounds.y, expected.y) &&
    near(bounds.width, expected.width) &&
    near(bounds.height, expected.height);
  check(
    name,
    matches,
    `bounds=${JSON.stringify(bounds)} expected=${JSON.stringify(expected)} content=${JSON.stringify(geometry.content)} zoom=${geometry.zoom}`,
  );
  return matches;
}

/** The page's own viewport, in CSS pixels, compared with the area it was given. */
function checkPageReflowed(name, geometry) {
  const { bounds, pageZoom, zoom, inner } = geometry;
  const expectedWidth = Math.round(bounds.width / (pageZoom > 0 ? pageZoom : 1));
  check(
    name,
    inner !== null && near(inner.width, expectedWidth, 2),
    `page innerWidth=${inner?.width} expected=${expectedWidth} shellZoom=${zoom} pageZoom=${pageZoom}`,
  );
  return inner?.width ?? 0;
}

const app = await electron.launch({
  executablePath: args.electron,
  args: [
    `--user-data-dir=${userData}`,
    // Chromium's sandbox cannot initialise inside a restricted agent shell, and a GPU
    // process that cannot start is fatal to the launch. Neither flag belongs to the
    // product: they are switches on this development run only.
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-sandbox',
    ...(args.packaged ? [] : [SHELL_DIR]),
    '--states',
    statesFile,
    '--services',
    servicesFile,
    '--dir',
    userData,
  ],
});

try {
  app.process().stderr?.on('data', (chunk) => stderrLog.write(String(chunk)));
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => window.anywhere.refresh('ready'));
  await page.waitForFunction(() => document.querySelectorAll('.card[data-service-id^="machine:"]').length > 0, null, {
    timeout: 15_000,
  });

  // A machine tab: its page is the native surface under test.
  await page.click('.card[data-service-id="machine:dsh.tower-lab.netbird"]');
  await page.waitForFunction(() => document.querySelectorAll('.tab').length === 2, null, { timeout: 15_000 });
  await waitForPageLoaded();
  await page.waitForTimeout(600);

  process.stdout.write('\nthe page is placed where the renderer says it is\n');
  let geometry = await readGeometry(page);
  check('the page loaded', geometry.url === SITE_URL, geometry.url);
  checkPlacement('bounds match the page area', geometry);
  const initialWidth = checkPageReflowed('the page fills the area', geometry);

  process.stdout.write('\nresizing the window larger\n');
  const grown = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const content = win.getContentBounds();
    win.setContentSize(content.width + 260, content.height + 180);
    return { width: content.width + 260, height: content.height + 180 };
  });
  await page.waitForTimeout(700);
  geometry = await readGeometry(page);
  check('the window grew', geometry.content.width === grown.width, JSON.stringify(geometry.content));
  checkPlacement('bounds followed the larger window', geometry);
  const widerWidth = checkPageReflowed('the page reflowed wider without a tab switch', geometry);
  check('the page really got wider', widerWidth > initialWidth + 200, `${initialWidth} -> ${widerWidth}`);
  await capturePage('page-after-growing.png');

  process.stdout.write('\nresizing the window smaller\n');
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const content = win.getContentBounds();
    win.setContentSize(content.width - 200, content.height - 120);
  });
  await page.waitForTimeout(700);
  geometry = await readGeometry(page);
  checkPlacement('bounds followed the smaller window', geometry);
  const narrowerWidth = checkPageReflowed('the page reflowed narrower without a tab switch', geometry);
  check('the page really got narrower', narrowerWidth < widerWidth - 150, `${widerWidth} -> ${narrowerWidth}`);
  await capturePage('page-after-shrinking.png');

  process.stdout.write('\nzooming the shell changes CSS pixels, not the window\n');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25);
  });
  await page.waitForTimeout(800);
  geometry = await readGeometry(page);
  check('the zoom took effect', geometry.zoom > 1.2, String(geometry.zoom));
  checkPlacement('bounds are placed in device pixels at 125%', geometry);
  checkPageReflowed('the page still fills the area at 125%', geometry);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1);
  });
  await page.waitForTimeout(600);
  geometry = await readGeometry(page);
  checkPlacement('bounds are restored at 100%', geometry);

  process.stdout.write('\nan overlay cannot be painted over a native page\n');
  await page.click('#open-palette');
  await page.waitForTimeout(300);
  geometry = await readGeometry(page);
  check('the palette is on screen', await page.locator('#palette').isVisible(), true);
  check('the native page stepped aside', geometry.visible === false, String(geometry.visible));
  await page.screenshot({ path: join(args.out, 'palette-over-page.png') });
  await capturePage('page-under-palette.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  geometry = await readGeometry(page);
  check('the native page came back', geometry.visible === true, String(geometry.visible));
  checkPlacement('the page came back to the same place', geometry);

  process.stdout.write('\nfull screen\n');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setFullScreen(true);
  });
  await page.waitForTimeout(1600);
  geometry = await readGeometry(page);
  checkPlacement('bounds follow full screen', geometry);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setFullScreen(false);
  });
  await page.waitForTimeout(1600);
  geometry = await readGeometry(page);
  checkPlacement('bounds follow the window out of full screen', geometry);

  process.stdout.write('\nfocus: a page keeps its own keys, so commands have to come from the menu\n');
  // A keystroke goes to whatever has focus. Once the page is focused, its keys reach the
  // page, not the shell renderer that owns the shortcut - which is why the command has to
  // exist in the menu as well.
  await app.evaluate(() => globalThis.__awWorkspace?.webContents.focus());
  await app.evaluate(() =>
    globalThis.__awWorkspace?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'k', modifiers: ['meta'] }),
  );
  await page.waitForTimeout(300);
  check(
    'a key pressed inside the page does not open the shell palette',
    (await page.locator('#palette').isVisible()) === false,
    'the palette stayed closed',
  );

  // The same command from the menu does reach the window, whichever layer has focus.
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    for (const top of menu.items) {
      for (const item of top.submenu?.items ?? []) {
        if (item.label === '跳到服务…') {
          item.click();
          return;
        }
        for (const sub of item.submenu?.items ?? []) {
          if (sub.label === '跳到服务…') {
            sub.click();
            return;
          }
        }
      }
    }
  });
  await page.waitForTimeout(400);
  check('the menu command opens the palette from inside the page', await page.locator('#palette').isVisible(), true);
  // A resize that happens while the overlay is up must not be lost: the surface comes
  // back at the size the window has now, not the size it had when it stepped aside.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const content = win.getContentBounds();
    win.setContentSize(content.width + 120, content.height + 80);
  });
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  geometry = await readGeometry(page);
  checkPlacement('a resize during an overlay is applied when it closes', geometry);

  process.stdout.write('\nmenu commands reach the window, not just the renderer\n');
  const commands = await app.evaluate(async ({ BrowserWindow, Menu }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const menu = Menu.getApplicationMenu();
    const find = (label) => {
      for (const top of menu.items) {
        for (const item of top.submenu?.items ?? []) {
          if (item.label === label) {
            return item;
          }
          for (const sub of item.submenu?.items ?? []) {
            if (sub.label === label) {
              return sub;
            }
          }
        }
      }
      return null;
    };
    const close = find('关闭页签');
    const opened = find('跳到服务…');
    const refresh = find('刷新');
    return {
      hasCloseTab: Boolean(close?.accelerator),
      hasPalette: Boolean(opened?.accelerator),
      refreshAccelerator: refresh?.accelerator ?? '',
      tabCountBefore: (globalThis.__awSnapshot?.tabs?.items ?? []).length,
      titlesBefore: (globalThis.__awSnapshot?.tabs?.items ?? []).map((tab) => tab.title),
      winId: win.id,
    };
  });
  check('the close-tab command has an accelerator', commands.hasCloseTab, String(commands.hasCloseTab));
  check('the jump-to-service command has an accelerator', commands.hasPalette, String(commands.hasPalette));
  // The menu is the layer a focused page cannot swallow, so the shortcut outlives the
  // control that names it: ⌘R has to exist here as well as on the strip.
  check('the refresh command keeps its menu accelerator', commands.refreshAccelerator, 'CommandOrControl+R');
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const click = (label) => {
      for (const top of menu.items) {
        for (const item of top.submenu?.items ?? []) {
          if (item.label === label) {
            item.click();
            return true;
          }
          for (const sub of item.submenu?.items ?? []) {
            if (sub.label === label) {
              sub.click();
              return true;
            }
          }
        }
      }
      return false;
    };
    click('关闭页签');
  });
  await page.waitForTimeout(700);
  check(
    'the close-tab command closed a tab',
    (await page.locator('.tab').count()) === 1,
    `${commands.tabCountBefore} tabs before`,
  );
} finally {
  await app.close();
  site.close();
}

process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
