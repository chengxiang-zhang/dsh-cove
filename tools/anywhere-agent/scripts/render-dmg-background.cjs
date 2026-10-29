/**
 * Rasterises the disk image's background, run by the runtime Electron at packaging time.
 *
 * The installer's job is that a person who has never seen this product knows what to do
 * with the window in front of them: the arrow points from the app to the Applications
 * folder, and one line says so in both languages. Nothing is hand-drawn and nothing is
 * hard-coded: the colours and the type come from the brand tokens, and the geometry comes
 * from the caller (`make-dmg.sh`), which is also what places the Finder icons - so the
 * arrow cannot end up pointing at empty space because two files disagree about where the
 * icons are.
 *
 * Invoked as:
 *   <electron> scripts/render-dmg-background.cjs <tokens.json> <out.png> \
 *     <width> <height> <appX> <appY> <appsX> <appsY> <iconSize>
 */

const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const [
  tokensPath, outPath, widthArg, heightArg,
  appXArg, appYArg, appsXArg, appsYArg, iconSizeArg,
] = process.argv.slice(2);

const width = Number(widthArg ?? 660);
const height = Number(heightArg ?? 420);
const appX = Number(appXArg ?? 170);
const appY = Number(appYArg ?? 195);
const appsX = Number(appsXArg ?? 490);
const iconSize = Number(iconSizeArg ?? 112);

if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
  process.stderr.write('render-dmg-background: the canvas size must be two positive numbers\n');
  app.exit(2);
}

/**
 * The brand's own token resolver, so this file cannot invent a colour: `tokens.json` is
 * the single source for every user-facing surface, and it is the file whose pairs the
 * brand gate asserts against WCAG AA.
 */
async function loadBrand() {
  const modulePath = resolve(__dirname, '../../../scripts/dsh-netbird-brand.mjs');
  return import(pathToFileURL(modulePath).href);
}

/** The background reads as the app's light surface: the window it previews is light. */
function paletteOf(tokens, resolveToken) {
  return {
    background: resolveToken(tokens, 'light', 'bg'),
    text: resolveToken(tokens, 'light', 'text'),
    muted: resolveToken(tokens, 'light', 'textMuted'),
    faint: resolveToken(tokens, 'light', 'textFaint'),
    brand: resolveToken(tokens, 'light', 'brand'),
  };
}

/** The arrow's geometry, derived from the icon slots the caller also places in the Finder. */
function geometryOf() {
  // One scale for both the 1x and the 2x raster: sizes are authored at the 1x canvas and
  // multiply out, so the Retina twin is the same picture at twice the resolution.
  const s = width / 660;
  const arrowY = appY;
  const arrowTo = appsX - iconSize / 2 - 34 * s;
  const head = 15 * s;
  return {
    s,
    arrowY,
    arrowFrom: appX + iconSize / 2 + 34 * s,
    arrowTo,
    head,
    stroke: Math.max(2, 5 * s),
    shaftEnd: arrowTo - head * 1.1,
  };
}

function pageOf(tokens, colours) {
  const sans = tokens.product.fontStack.sans;
  const { s, arrowY, arrowFrom, arrowTo, head, stroke, shaftEnd } = geometryOf();
  const px = (value) => `${(value * s).toFixed(2)}px`;

  return `<html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: 100vw; height: 100vh; overflow: hidden;
      background: ${colours.background}; font-family: ${sans};
      -webkit-font-smoothing: antialiased; }
    .title { position: absolute; left: 0; right: 0; top: ${px(78)}; text-align: center;
      font-size: ${px(23)}; font-weight: 600; letter-spacing: ${px(-0.2)}; color: ${colours.text}; }
    .sub { position: absolute; left: 0; right: 0; top: ${px(112)}; text-align: center;
      font-size: ${px(13.5)}; color: ${colours.muted}; }
    .caption { position: absolute; left: ${px(40)}; right: ${px(40)}; top: ${px(352)};
      text-align: center; font-size: ${px(12)}; line-height: 1.55; color: ${colours.faint}; }
  </style></head>
  <body>
    <div class="title">${tokens.product.name}</div>
    <div class="sub">拖到「应用程序」文件夹 &nbsp;·&nbsp; Drag it to the Applications folder</div>
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
         style="position:absolute;left:0;top:0">
      <line x1="${arrowFrom}" y1="${arrowY}" x2="${shaftEnd}" y2="${arrowY}"
            stroke="${colours.brand}" stroke-width="${stroke}" stroke-linecap="round" />
      <path d="M ${arrowTo} ${arrowY} L ${shaftEnd - head * 0.2} ${arrowY - head}
            L ${shaftEnd - head * 0.2} ${arrowY + head} Z" fill="${colours.brand}" />
    </svg>
    <div class="caption">首次打开被 macOS 拦下?放行一次的方法见窗口里的「安装说明」<br />
      First launch blocked by macOS? The install notes in this window say how to allow it once.</div>
  </body></html>`;
}

/**
 * The arrow is the one thing on this picture that carries meaning, and an unclosed
 * attribute once shipped a background whose arrowhead was silently missing - the line
 * rendered, the picture looked plausible, and nothing pointed at the folder. So the
 * triangle's rendered box is measured against the box that was authored.
 */
function arrowCheck() {
  const { arrowY, arrowTo, head, shaftEnd } = geometryOf();
  const baseX = shaftEnd - head * 0.2;
  const width = arrowTo - baseX;
  const height = head * 2;
  return `(() => {
    const path = document.querySelector('svg path');
    if (path === null) return 'the arrowhead element is not in the page';
    const box = path.getBoundingClientRect();
    const want = { x: ${baseX}, y: ${arrowY - head}, width: ${width}, height: ${height} };
    const near = (a, b) => Math.abs(a - b) <= 1.5;
    if (!near(box.width, want.width) || !near(box.height, want.height)) {
      return 'the arrowhead rendered ' + box.width.toFixed(1) + 'x' + box.height.toFixed(1) +
        ', expected ' + want.width.toFixed(1) + 'x' + want.height.toFixed(1);
    }
    if (!near(box.x, want.x) || !near(box.y, want.y)) {
      return 'the arrowhead rendered at ' + box.x.toFixed(1) + ',' + box.y.toFixed(1) +
        ', expected ' + want.x.toFixed(1) + ',' + want.y.toFixed(1);
    }
    return '';
  })()`;
}

app.whenReady().then(async () => {
  try {
    const { loadTokens, resolveToken } = await loadBrand();
    const tokens = loadTokens(tokensPath);
    const colours = paletteOf(tokens, resolveToken);

    const window = new BrowserWindow({
      width,
      height,
      // The canvas has to be the content area, or the capture is the window minus its
      // chrome and the Finder draws a cropped picture.
      useContentSize: true,
      show: false,
      frame: false,
      backgroundColor: colours.background,
      webPreferences: { offscreen: false },
    });
    const page = pageOf(tokens, colours);
    await window.loadURL(`data:text/html;base64,${Buffer.from(page).toString('base64')}`);
    // Text has to be laid out in the real font before the capture, or the PNG carries a
    // fallback face and the wrong metrics.
    await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    const arrowProblem = await window.webContents.executeJavaScript(arrowCheck());
    if (arrowProblem !== '') {
      process.stderr.write(`render-dmg-background: ${arrowProblem}\n`);
      app.exit(1);
      return;
    }
    await new Promise((done) => setTimeout(done, 400));
    let image = await window.webContents.capturePage();
    // A Retina host captures at device resolution; the file the Finder draws has to be
    // exactly the canvas, so the size is asserted rather than assumed.
    const size = image.getSize();
    if (size.width !== width || size.height !== height) {
      image = image.resize({ width, height, quality: 'best' });
    }
    const png = image.toPNG();
    if (png.length === 0) {
      process.stderr.write('render-dmg-background: captured nothing\n');
      app.exit(1);
      return;
    }
    writeFileSync(outPath, png);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`render-dmg-background: ${error.message}\n`);
    app.exit(1);
  }
});