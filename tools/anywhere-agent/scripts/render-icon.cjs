/**
 * Rasterises the brand's icon artwork, run by the staged Electron during packaging.
 *
 * The app icon is a vector (`favicon.svg`, 64x64 with the product's dark rounded square
 * and mark) and macOS wants a 1024px raster to build an `.icns` from. Rasterising needs a
 * renderer, and the packaging script already has the Electron runtime staged - so the
 * icon is produced from the brand's own file instead of a hand-drawn stand-in, and a
 * change to the mark changes the Dock icon on the next build.
 *
 * Invoked as: <electron> scripts/render-icon.cjs <svg> <out.png> <size>
 */

const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

const [svgPath, outPath, sizeArg] = process.argv.slice(2);
const size = Number(sizeArg ?? 1024);

/** Inlines an SVG's relative image references, so it renders the same from anywhere. */
function inlineImages(svg, baseDir) {
  return svg.replace(/href="([^"]+\.png)"/g, (match, href) => {
    if (href.startsWith('data:') || /^[a-z]+:/i.test(href)) {
      return match;
    }
    const file = resolve(baseDir, href);
    return `href="data:image/png;base64,${readFileSync(file).toString('base64')}"`;
  });
}

app.whenReady().then(async () => {
  try {
  const svg = inlineImages(readFileSync(svgPath, 'utf8'), dirname(resolve(svgPath)));
  const window = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: false },
  });
  // The artwork fills the viewport rather than being sized in pixels: a window's content
  // area is not exactly what was asked for, and an image larger than it produces
  // scrollbars and a capture of the top-left corner only.
  const page = `<html style="margin:0;background:transparent;overflow:hidden">
    <style>html,body{margin:0;overflow:hidden}img{display:block;width:100vw;height:100vh}</style>
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" />
  </html>`;
  await window.loadURL(`data:text/html;base64,${Buffer.from(page).toString('base64')}`);
  // The image has to have decoded before the capture, or the PNG is empty.
  await window.webContents.executeJavaScript('document.querySelector("img").decode().catch(() => {})');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await window.webContents.capturePage();
  const png = image.toPNG();
  if (png.length === 0) {
    process.stderr.write('render-icon: captured nothing\n');
    app.exit(1);
    return;
  }
  writeFileSync(outPath, png);
  app.exit(0);
  } catch (error) {
    process.stderr.write(`render-icon: ${error.message}\n`);
    app.exit(1);
  }
});