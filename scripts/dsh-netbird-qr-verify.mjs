/**
 * qr-verify - prove that the phone QR shipped on the landing page still scans.
 *
 * The asset is a hand-drawn SVG (tools/dsh-netbird/client/qr-phone.svg) whose
 * only job is to open the download page when a phone points at it. Nothing else
 * in the repository can tell whether it still does: a single flipped module or a
 * changed stroke leaves something that looks exactly like a QR code and decodes
 * to nothing, and the first person to notice would be an employee holding up a
 * phone. So this decodes the committed asset with the browser's own
 * BarcodeDetector and compares the payload with the URL the client channel
 * publishes, instead of assuming the drawing is still correct.
 *
 * This is a manual evidence script and deliberately NOT part of
 * `pnpm test:scripts`: it launches a real Chromium, and paying for a browser in
 * the unit-test suite would make the suite slow and flaky in CI for one asset.
 *
 *   node scripts/dsh-netbird-qr-verify.mjs
 *
 * Nothing is fetched over the network. The SVG is inlined into a page built with
 * page.setContent, serialized back out and rasterized on a canvas. The page is
 * opened on a file:// URL first only because BarcodeDetector is gated behind a
 * secure context and about:blank - where setContent would otherwise leave the
 * document - is not one.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { chromium } from 'playwright'

/**
 * The payload the QR must carry. It is the download page the landing page, the
 * installer one-liner and the published APK all live behind, so a change here is
 * a change to the client channel and not to this script.
 */
export const EXPECTED_QR_URL = 'https://anywhere.example.com/'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const QR_SVG_FILE = 'tools/dsh-netbird/client/qr-phone.svg'
const QR_SVG = join(ROOT, QR_SVG_FILE)

function fail(message) {
  console.error(`qr-verify: ${message}`)
  process.exit(1)
}

const svg = readFileSync(QR_SVG, 'utf8')

// The SVG is inlined, not referenced: the page must not fetch anything, and the
// bytes that get decoded have to be the bytes the landing page serves.
const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>qr-verify</title></head>
<body>
<div id="source">${svg}</div>
<canvas id="qr"></canvas>
</body></html>`

let browser
try {
  browser = await chromium.launch()
} catch (error) {
  fail(`could not launch Chromium (run \`npx playwright install chromium\`): ${error.message}`)
}

let outcome
try {
  const page = await browser.newPage()
  await page.goto(pathToFileURL(tmpdir()).href)
  await page.setContent(html)
  outcome = await page.evaluate(async () => {
    if (typeof BarcodeDetector === 'undefined') {
      return { error: 'BarcodeDetector is unavailable, so the asset cannot be proven to scan' }
    }
    const formats = await BarcodeDetector.getSupportedFormats()
    if (!formats.includes('qr_code')) {
      return { error: `this browser cannot detect qr_code (supported: ${formats.join(', ')})` }
    }

    // Serialize the inlined SVG rather than rebuilding its markup in script, so
    // the rasterized image is the asset as it ships.
    const markup = new XMLSerializer().serializeToString(document.querySelector('#source svg'))
    const objectUrl = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))
    try {
      const image = new Image()
      await new Promise((resolve, reject) => {
        image.onload = resolve
        image.onerror = () => reject(new Error('the SVG did not load as an image'))
        image.src = objectUrl
      })
      if (!image.naturalWidth || !image.naturalHeight) {
        throw new Error('the SVG has no intrinsic size, so it rasterizes to nothing')
      }

      const canvas = document.getElementById('qr')
      // Rasterize at the asset's own size: resampling a crisp-edge QR is how a
      // valid code starts decoding as noise.
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      context.fillStyle = '#FFFFFF'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0)

      const codes = await new BarcodeDetector({ formats: ['qr_code'] }).detect(canvas)
      return { values: codes.map((code) => code.rawValue) }
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  })
} catch (error) {
  outcome = { error: error.message }
} finally {
  await browser.close()
}

if (outcome.error) {
  fail(outcome.error)
}
if (outcome.values.length !== 1) {
  const found = outcome.values.length ? `: ${outcome.values.join(', ')}` : ''
  fail(`expected exactly one QR code in qr-phone.svg, found ${outcome.values.length}${found}`)
}
if (outcome.values[0] !== EXPECTED_QR_URL) {
  fail(`the QR decodes to ${outcome.values[0]}, but the channel serves ${EXPECTED_QR_URL}`)
}

console.log(`qr-verify: ${QR_SVG_FILE} decodes to ${outcome.values[0]}`)