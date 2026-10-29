/**
 * The brand contract: `tools/dsh-netbird/brand/tokens.json` claims to be the one
 * source every user-facing surface derives from, and the surfaces it derives are
 * the desktop client landing page, the Android app theme and the management
 * console skin. That claim is only worth anything if drift is caught here,
 * offline, rather than by noticing two screens look slightly different.
 *
 * What is pinned:
 *
 *   - every semantic colour resolves in both schemes, and both schemes expose
 *     the same keys, because a screen reads one key set and picks the scheme at
 *     runtime;
 *   - the contrast contract passes and is not vacuous;
 *   - every generated consumer matches the tokens, and the check that says so
 *     actually reacts to a changed token;
 *   - no retired colour has come back (the product used to ship three different
 *     brand blues and four navies);
 *   - the phone QR asset is shipped, well formed and offered with alt text;
 *   - the vendor name only reaches an end user through the footer sentence that
 *     deliberately discloses the transport.
 *
 *   node --test scripts/dsh-netbird-brand.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkBrand, checkContrast, loadTokens, renderPlan, resolveToken } from './dsh-netbird-brand.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const LANDING = 'tools/dsh-netbird/client/index.html'
const APP_THEME = 'tools/netbird-client/src/theme/tokens.ts'
const CONSOLE_CSS = 'tools/dsh-netbird/brand/dashboard/aw-brand.css'
const CASDOOR_SQL = 'tools/dsh-netbird/casdoor-theme.sql'

/**
 * Every file that ships a colour to a person. Read-only: the test never writes.
 *
 * The Android entries are walked rather than listed because the native workspace
 * activity (`GeckoServiceActivity.kt`) is hand-built Kotlin, not React Native: it
 * carried the previous brand blue on a white toolbar long after the token system
 * existed, and nothing in this guard was looking at Kotlin at all. Shipping a
 * brand colour is what makes a file a consumer, not the language it is written in.
 */
const SINGLE_FILES = [LANDING, APP_THEME, CONSOLE_CSS, CASDOOR_SQL]
const WALKED = [
  'tools/netbird-client/android/app/src/main/java',
  'tools/netbird-client/android/app/src/main/res',
  'tools/netbird-client/src',
]

function walk(relative, extensions) {
  const found = []
  const visit = (current) => {
    for (const entry of readdirSync(join(ROOT, current), { withFileTypes: true })) {
      const next = `${current}/${entry.name}`
      if (entry.isDirectory()) {
        visit(next)
      } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
        found.push(next)
      }
    }
  }
  visit(relative)
  return found
}

const CONSUMERS = [...SINGLE_FILES, ...WALKED.flatMap((dir) => walk(dir, ['.kt', '.xml', '.ts', '.tsx']))]

function read(relative) {
  const path = join(ROOT, relative)
  assert.ok(existsSync(path), `${relative} is missing; it is a shipped brand surface`)
  return readFileSync(path, 'utf8')
}

test('every semantic colour resolves in both schemes, with identical key sets', () => {
  const tokens = loadTokens()
  const light = Object.keys(tokens.semantic.light)
  const dark = Object.keys(tokens.semantic.dark)

  // Screens read the same key from whichever scheme the OS asks for, so a key
  // that exists in only one scheme is an undefined token in the other.
  assert.deepEqual([...light].sort(), [...dark].sort(), 'the light and dark schemes must expose the same colour keys')

  for (const scheme of ['light', 'dark']) {
    for (const key of Object.keys(tokens.semantic[scheme])) {
      // resolveToken throws when the key is missing or points at a primitive
      // that does not exist, which is exactly the failure being pinned.
      const value = resolveToken(tokens, scheme, key)
      assert.equal(typeof value, 'string', `semantic.${scheme}.${key} did not resolve to a colour`)
      assert.ok(value.length > 0, `semantic.${scheme}.${key} resolved to an empty value`)
      // A leftover `group.step` reference means a consumer would receive the
      // reference itself, because only this generator knows how to follow it.
      assert.doesNotMatch(value, /^[a-z]+\.[A-Za-z0-9]+$/, `semantic.${scheme}.${key} is still an unresolved reference`)
    }
  }
})

test('the contrast contract passes and is not vacuous', () => {
  const tokens = loadTokens()
  const failures = checkContrast(tokens)
  // The generator owns the maths; this only asserts its verdict, so a palette
  // cannot be changed into an inaccessible one without a red test.
  assert.deepEqual(failures, [], `WCAG failures:\n  ${failures.join('\n  ')}`)
  // A floor, not a target: it keeps the assertion above from passing vacuously
  // if the contract array were ever emptied or truncated.
  assert.ok(tokens.contrast.length >= 30, `only ${tokens.contrast.length} contrast pairs; the contract needs at least 30`)
})

test('every generated consumer is in sync with tokens.json', () => {
  const problems = checkBrand(loadTokens())
  assert.deepEqual(problems, [], `brand drift:\n  ${problems.join('\n  ')}`)
})

test('checkBrand reports drift, so the sync test is not vacuous', () => {
  // A deep clone mutated in memory: checkBrand renders the expected content
  // from the tokens it is handed and compares it with the committed files, so
  // nothing on disk is touched.
  const tokens = structuredClone(loadTokens())
  tokens.primitive.blue.core = '#123456'

  const problems = checkBrand(tokens)
  assert.ok(problems.length > 0, 'checkBrand stayed silent after a primitive changed')
  assert.match(problems.join('\n'), /tools\/dsh-netbird\/client\/index\.html/, 'the landing page should derive its brand fill from blue.core')

  // And the on-disk consumers are still in sync: the mutation never escaped
  // this test. A regression here would mean the guard is writing as it checks.
  assert.deepEqual(checkBrand(loadTokens()), [], 'checking for drift modified the committed files')
})

test('no retired colour has come back on a shipped surface', () => {
  const tokens = loadTokens()
  const retired = Object.keys(tokens.retired).filter((key) => key.startsWith('#'))
  assert.ok(retired.length >= 5, `only ${retired.length} retired colours recorded; the guard would be near-empty`)
  // A guard that silently stops covering a surface is worse than no guard, so the
  // breadth is asserted: the native sources and the Android resources must be in.
  assert.ok(CONSUMERS.length >= 15, `only ${CONSUMERS.length} surfaces scanned; the sweep has narrowed`)
  for (const expected of ['GeckoServiceActivity.kt', 'aw_colors.xml', 'values-night/aw_colors.xml']) {
    assert.ok(
      CONSUMERS.some((file) => file.includes(expected)),
      `${expected} is not scanned for retired colours`,
    )
  }

  // Case-insensitive because the same colour is written `#2F7BF6` in SQL and
  // `#2f7bf6` in JSON. The point is the colour, not how it was spelled.
  const violations = []
  for (const file of CONSUMERS) {
    const source = read(file).toLowerCase()
    for (const colour of retired) {
      const count = source.split(colour.toLowerCase()).length - 1
      if (count > 0) {
        violations.push(`${file}: ${colour} appears ${count} time(s)`)
      }
    }
  }
  assert.deepEqual(violations, [], `retired colours are back:\n  ${violations.join('\n  ')}`)
})

test('the phone QR asset ships, is well formed and is offered with alt text', () => {
  const svg = read('tools/dsh-netbird/client/qr-phone.svg')
  assert.match(svg, /<svg\s/, 'qr-phone.svg does not open with an <svg> element')
  assert.match(svg, /<\/svg>/, 'qr-phone.svg is not closed')
  assert.match(svg, /\bwidth="\d+"/, 'qr-phone.svg declares no numeric width')
  assert.match(svg, /\bheight="\d+"/, 'qr-phone.svg declares no numeric height')
  assert.match(svg, /\bviewBox="[0-9.\- ]+"/, 'qr-phone.svg declares no numeric viewBox')

  // A scanner needs the light modules to be a real white area, not the page
  // showing through: without the full-bleed background the code only decodes on
  // a white page, which is exactly the failure that is invisible in a browser.
  const paths = svg.match(/<path\b[^>]*>/g) ?? []
  assert.ok(
    paths.some((tag) => /fill="#FFFFFF"/.test(tag) && /\bd="M0 0h/.test(tag)),
    'the QR has no full-bleed white background path',
  )

  const html = read(LANDING)
  const image = /<img\b[^>]*\bsrc="qr-phone\.svg"[^>]*>/.exec(html)
  assert.ok(image, 'index.html no longer offers the phone QR code')
  assert.match(image[0], /\balt="[^"]+"/, 'the QR image ships without alt text')
})

test('the vendor name reaches an end user only through the footer disclosure', () => {
  const html = read(LANDING)
  // The product is Anywhere Work; NetBird is only the transport underneath it.
  // One deliberate sentence in the footer says so - in the data-zh value, the
  // data-en value and the visible Chinese text. Anywhere else the string would
  // reach an end user as if it were the product's own name.
  const disclosure = '传输层用的是开源的 NetBird'
  const at = html.indexOf(disclosure)
  assert.notEqual(at, -1, 'the footer no longer discloses the transport layer')

  // The rule is containment in that one element rather than the 200-character
  // window it replaces: it is simpler to state and strictly stronger, because an
  // occurrence 200 characters away in the header, a button label or a title is a
  // leak, not a disclosure.
  const elementStart = html.lastIndexOf('<p', at)
  const elementEnd = html.indexOf('</p>', at)
  assert.ok(elementStart !== -1 && elementEnd > at, 'could not delimit the footer disclosure element')

  const occurrences = [...html.matchAll(/NetBird/g)].map((match) => match.index)
  assert.ok(occurrences.length > 0, 'the transport is no longer disclosed at all')
  assert.ok(occurrences.length <= 6, `NetBird appears ${occurrences.length} times; add no new mentions outside the footer`)

  const leaked = occurrences.filter((index) => index < elementStart || index > elementEnd)
  assert.deepEqual(leaked, [], `NetBird leaks outside the footer disclosure at offset(s) ${leaked.join(', ')}`)

  // The window is still asserted, so the disclosure cannot be separated from the
  // name it is disclosing by moving either of them.
  for (const index of occurrences) {
    const window = html.slice(Math.max(0, index - 200), index + 200)
    assert.ok(
      window.includes('传输层') || window.includes('open-source NetBird'),
      `NetBird at offset ${index} is not next to the sentence that discloses it`,
    )
  }
})
test('the desktop icon is the phone icon, not a redrawing of it', () => {
  const icon = readFileSync(join(ROOT, 'tools/anywhere-agent/icons/app-icon.svg'), 'utf8')
  // Composed from the layers the Android client ships, so the two can never disagree.
  assert.match(icon, /ic_launcher_background\.png/)
  assert.match(icon, /ic_launcher_foreground\.png/)
  // And it chooses nothing itself: no colour, no glyph. Two earlier versions picked a
  // palette and dropped the rounding; both were the shell overruling the brand.
  assert.equal(/fill="#[0-9A-Fa-f]{3,8}"/.test(icon), false, 'no colour of its own')
  assert.equal(/stroke="#[0-9A-Fa-f]{3,8}"/.test(icon), false, 'no stroke of its own')
  assert.equal(/<circle|<path/.test(icon), false, 'no glyph of its own')
});

test('generated artifacts live with their consumer, not in the asset source', () => {
  const plan = renderPlan(loadTokens())
  const inSource = plan.filter((entry) => entry.file.startsWith('tools/dsh-netbird/brand/')).map((entry) => entry.file)
  // The console stylesheet is the one long-standing exception, recorded in SOURCES.md.
  assert.deepEqual(inSource, ['tools/dsh-netbird/brand/dashboard/aw-brand.css'])
  const icon = plan.find((entry) => entry.file.endsWith('app-icon.svg'))
  assert.match(icon.file, /^tools\/anywhere-agent\//, 'the icon is generated beside its consumer')
});

test('the source of truth for assets is declared', () => {
  const doc = readFileSync(join(ROOT, 'tools/dsh-netbird/brand/SOURCES.md'), 'utf8')
  for (const needle of ['tokens.json', 'ic_launcher_foreground.png', 'logo-mark.svg', '不得写回本目录']) {
    assert.ok(doc.includes(needle), `SOURCES.md names ${needle}`)
  }
});
