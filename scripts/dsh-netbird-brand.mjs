/**
 * Anywhere Work brand token generator.
 *
 * `tools/dsh-netbird/brand/tokens.json` is the single source of truth for the
 * product's colour, spacing, radius, type, motion and elevation scales. This
 * script derives the consumers from it so the four user-facing surfaces cannot
 * drift apart again:
 *
 *   - the desktop client landing page  (tools/dsh-netbird/client/index.html)
 *   - the Android app theme            (tools/netbird-client/src/theme/tokens.ts)
 *   - the management console skin      (tools/dsh-netbird/brand/dashboard/aw-brand.css)
 *   - the native Android colour resources (res/values and res/values-night)
 *
 * The landing page and the console skin are hand-written files that carry a
 * generated region between `/* AW-TOKENS:START *` + `/` and `/* AW-TOKENS:END *`
 * + `/`; the app theme file is generated whole, because nothing in it is
 * hand-written. Regenerate, then verify:
 *
 *   node scripts/dsh-netbird-brand.mjs --write
 *   node scripts/dsh-netbird-brand.mjs --check      # exits 1 on any drift
 *   node --test scripts/dsh-netbird-brand.test.mjs  # also asserts the palette
 *
 * Before this existed the product shipped three different brand blues
 * (#2f7bf6 on the landing page and sign-in page, #2563EB in the app theme,
 * #1c7ed6 hardcoded in two app screens) and four different navies. The
 * `retired` map in tokens.json records each of them so a grep that finds one is
 * a regression, not a matter of taste.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TOKENS_FILE = join(ROOT, 'tools/dsh-netbird/brand/tokens.json')

export const START = '/* AW-TOKENS:START */'
export const END = '/* AW-TOKENS:END */'

const LANDING = 'tools/dsh-netbird/client/index.html'
const APP_THEME = 'tools/netbird-client/src/theme/tokens.ts'
const CONSOLE_CSS = 'tools/dsh-netbird/brand/dashboard/aw-brand.css'
const SHELL_TOKENS = 'tools/anywhere-agent/shell/renderer/tokens.css'
const SHELL_TOKENS_JSON = 'tools/anywhere-agent/shell/renderer/tokens.json'
const SHELL_BRAND_JS = 'tools/anywhere-agent/shell/renderer/brand.js'
const SHELL_APP_ICON = 'tools/anywhere-agent/icons/app-icon.svg'
const ANDROID_RES = 'tools/netbird-client/android/app/src/main/res'
const ANDROID_LIGHT = `${ANDROID_RES}/values/aw_colors.xml`
const ANDROID_DARK = `${ANDROID_RES}/values-night/aw_colors.xml`

export function loadTokens(file = TOKENS_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Resolve a semantic token to a literal, following one `primitive.key` hop. */
export function resolveToken(tokens, scheme, key) {
  const value = tokens.semantic[scheme][key]
  if (value === undefined) {
    throw new Error(`semantic.${scheme}.${key} is not defined in tokens.json`)
  }
  // Only `group.step` is a reference; anything else (a hex, an rgba() for an
  // overlay or a shadow) is already a literal colour.
  if (!/^[a-z]+\.[A-Za-z0-9]+$/.test(value)) {
    return value
  }
  const [group, step] = value.split('.')
  const resolved = tokens.primitive[group]?.[step]
  if (!resolved) {
    throw new Error(`semantic.${scheme}.${key} points at missing primitive ${value}`)
  }
  return resolved
}

/**
 * Resolve a contrast-contract reference. An entry may name a semantic token of
 * its own scheme (`surface`), a step of the console ladder (`ladder.600`), or a
 * literal (`#FFFFFF`) where the pair is not itself a token, such as white button
 * text.
 */
export function resolveRef(tokens, scheme, ref) {
  if (ref.startsWith('#')) {
    return ref
  }
  if (ref.startsWith('ladder.')) {
    const step = ref.slice('ladder.'.length)
    const value = tokens.consoleLadder[step]
    if (!value) {
      throw new Error(`contrast reference ${ref} is not a consoleLadder step`)
    }
    return value
  }
  return resolveToken(tokens, scheme, ref)
}

/**
 * Assert every pair in the tokens' contrast contract. Ratios are compared
 * unrounded: 4.499:1 does not meet a 4.5:1 threshold (WCAG 2.x, SC 1.4.3).
 * Returns a list of human-readable failures; empty means the palette is sound.
 */
export function checkContrast(tokens = loadTokens()) {
  const failures = []
  for (const entry of tokens.contrast) {
    const fg = resolveRef(tokens, entry.scheme, entry.fg)
    const bg = resolveRef(tokens, entry.scheme, entry.bg)
    const ratio = contrastRatio(fg, bg)
    if (ratio === null) {
      failures.push(`${entry.pair} (${entry.scheme}): ${entry.fg} on ${entry.bg} is not a plain hex pair`)
      continue
    }
    if (ratio < entry.min) {
      failures.push(
        `${entry.pair} (${entry.scheme}): ${ratio.toFixed(2)}:1 is below ${entry.min}:1 (${fg} on ${bg})`,
      )
    }
  }
  return failures
}

export function parseColor(value) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(value)
  if (!match) {
    return null
  }
  const hex = match[1]
  return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16))
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map(channel => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.x contrast ratio; null when either side is not a plain 6-digit hex. */
export function contrastRatio(foreground, background) {
  const fg = parseColor(foreground)
  const bg = parseColor(background)
  if (!fg || !bg) {
    return null
  }
  const a = relativeLuminance(fg)
  const b = relativeLuminance(bg)
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

function cssColorTokens(tokens, scheme) {
  const keys = Object.keys(tokens.semantic[scheme])
  return keys.map(key => `  --aw-${kebab(key)}: ${resolveToken(tokens, scheme, key)};`).join('\n')
}

function cssScaleTokens(tokens) {
  const lines = []
  for (const [name, value] of Object.entries(tokens.space)) {
    lines.push(`  --aw-space-${name}: ${value}px;`)
  }
  for (const [name, value] of Object.entries(tokens.radius)) {
    lines.push(`  --aw-radius-${name}: ${value}px;`)
  }
  for (const [name, spec] of Object.entries(tokens.type.web)) {
    lines.push(`  --aw-size-${name}: ${spec.size}px;`)
    lines.push(`  --aw-leading-${name}: ${spec.lineHeight};`)
    lines.push(`  --aw-weight-${name}: ${spec.weight};`)
    lines.push(`  --aw-tracking-${name}: ${spec.tracking};`)
  }
  for (const [name, ms] of Object.entries(tokens.motion)) {
    lines.push(Number.isFinite(ms) ? `  --aw-dur-${name}: ${ms}ms;` : `  --aw-${kebab(name)}: ${ms};`)
  }
  for (const [name, shadow] of Object.entries(tokens.elevation.web)) {
    lines.push(`  --aw-shadow-${name}: ${shadow};`)
  }
  lines.push(`  --aw-font-sans: ${tokens.product.fontStack.sans};`)
  lines.push(`  --aw-font-mono: ${tokens.product.fontStack.mono};`)
  return lines.join('\n')
}

function kebab(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * A TypeScript object key. Scale steps start with a digit (`3xs`, `2xs`), and an
 * unquoted numeric-leading key is a syntax error in TS, so those get quoted.
 */
function prop(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `'${name}'`
}

/**
 * The landing page's generated region: the light palette on `:root`, the dark
 * palette for both an explicit `data-theme="dark"` and the OS preference, so a
 * reader who never touches the toggle still gets the right scheme.
 */
export function landingTokens(tokens) {
  const light = cssColorTokens(tokens, 'light')
  const dark = cssColorTokens(tokens, 'dark')
  const scale = cssScaleTokens(tokens)
  const indented = (block, prefix) =>
    block
      .split('\n')
      .map(line => `${prefix}${line}`)
      .join('\n')
  return `:root {
${light}
${scale}
  color-scheme: light;
}

/* The reader who never touches the toggle still gets the scheme the OS asks for. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
${indented(dark, '  ')}
    color-scheme: dark;
  }
}

:root[data-theme='dark'] {
${dark}
  color-scheme: dark;
}

:root[data-theme='light'] {
  color-scheme: light;
}`
}

/** The app theme module. Generated whole: it contains no hand-written logic. */
export function appThemeModule(tokens) {
  const scheme = name =>
    Object.keys(tokens.semantic[name])
      .map(key => `  ${key}: '${resolveToken(tokens, name, key)}',`)
      .join('\n')

  const typeScale = Object.entries(tokens.type.app)
    .map(([name, spec]) => {
      const family = name.startsWith('mono') ? 'mono' : 'sans'
      const medium = name === 'display' || name === 'title' || name === 'heading' || name === 'label'
      return `  ${name}: {fontFamily: ${family === 'mono' ? 'mono' : medium ? 'sansMedium' : 'sans'}, fontSize: ${spec.size}, lineHeight: ${spec.lineHeight}, fontWeight: '${spec.weight}' as const},`
    })
    .join('\n')

  return `/**
 * Anywhere Work design tokens.
 *
 * GENERATED FILE - do not edit. The source of truth is
 * tools/dsh-netbird/brand/tokens.json; regenerate with
 * \`node scripts/dsh-netbird-brand.mjs --write\` from the repository root and let
 * \`pnpm test:scripts\` prove the three consumers agree.
 *
 * Colours arrive as \`light\` and \`dark\` records with identical keys, so a screen
 * can never reference a colour that only exists in one scheme. Every text pair
 * that ships is asserted against WCAG AA by scripts/dsh-netbird-brand.test.mjs.
 *
 * Identifiers - host names, URLs, ports, status codes, versions - use the mono
 * face: they are meant to be compared character by character, which a
 * proportional face makes hard.
 */
import {Platform, useColorScheme} from 'react-native';

export type Scheme = 'light' | 'dark';

export type SchemeColors = {
${Object.keys(tokens.semantic.light).map(key => `  ${key}: string;`).join('\n')}
};

export const light: SchemeColors = {
${scheme('light')}
};

export const dark: SchemeColors = {
${scheme('dark')}
};

/** 4-point spacing scale, in density-independent pixels. */
export const space = {
${Object.entries(tokens.space).map(([name, value]) => `  ${prop(name)}: ${value},`).join('\n')}
} as const;

export const radius = {
${Object.entries(tokens.radius).map(([name, value]) => `  ${prop(name)}: ${value},`).join('\n')}
} as const;

/** Durations in milliseconds, for Animated timing configs. */
export const motion = {
${Object.entries(tokens.motion).filter(([, value]) => Number.isFinite(value)).map(([name, value]) => `  ${prop(name)}: ${value},`).join('\n')}
} as const;

export const elevation = {
${Object.entries(tokens.elevation.app).map(([name, value]) => `  ${prop(name)}: ${value},`).join('\n')}
} as const;

const sans = Platform.select({ios: 'System', android: 'sans-serif', default: 'System'});
const sansMedium = Platform.select({ios: 'System', android: 'sans-serif-medium', default: 'System'});
const mono = Platform.select({ios: 'Menlo', android: 'monospace', default: 'monospace'});

export const type = {
${typeScale}
} as const;

export function theme(scheme: Scheme | null | undefined) {
  return {c: scheme === 'dark' ? dark : light, space, radius, type, motion, elevation};
}

export function useTheme() {
  return theme(useColorScheme());
}
`
}

/**
 * The management console skin region: NetBird's dashboard is a compiled Next.js
 * export whose own design system names its accent utilities after the vendor
 * (\`bg-netbird\`, \`text-netbird\`, \`nb-gray\`). The vendor palette is not exposed
 * as CSS custom properties, so the only surgical override is by utility name.
 */
export function consoleTokens(tokens) {
  const ladder = Object.entries(tokens.consoleLadder)
    .filter(([key]) => !key.startsWith('$'))
    .map(([step, value]) => `  --aw-ladder-${step}: ${value};`)
    .join('\n')
  return `  --aw-brand-fill: ${tokens.consoleLadder['600']};
  --aw-brand-fill-hover: ${tokens.consoleLadder['700']};
  --aw-brand-on-fill: #FFFFFF;
  --aw-brand-text-on-dark: ${tokens.consoleLadder['400']};
  --aw-brand-text-on-light: ${tokens.consoleLadder['700']};
${ladder}
  --aw-bg-dark: ${resolveToken(tokens, 'dark', 'bg')};
  --aw-surface-dark: ${resolveToken(tokens, 'dark', 'surface')};
  --aw-surface-alt-dark: ${resolveToken(tokens, 'dark', 'surfaceAlt')};
  --aw-border-dark: ${resolveToken(tokens, 'dark', 'border')};
  --aw-text-dark: ${resolveToken(tokens, 'dark', 'text')};
  --aw-text-muted-dark: ${resolveToken(tokens, 'dark', 'textMuted')};
  --aw-control-border-dark: ${resolveToken(tokens, 'dark', 'controlBorder')};
  --aw-font-sans: ${tokens.product.fontStack.sans};
  --aw-radius-sm: ${tokens.radius.sm}px;
  --aw-radius-md: ${tokens.radius.md}px;
  --aw-dur-fast: ${tokens.motion.fast}ms;
  --aw-ease-standard: ${tokens.motion.easeStandard};`
}

/**
 * Convert a token value to an Android `<color>` literal. Android has no rgba();
 * translucency is the alpha byte of #AARRGGBB.
 */
export function androidColor(value) {
  const rgba = /^rgba\(([^)]+)\)$/.exec(value)
  if (rgba) {
    const [r, g, b, a] = rgba[1].split(',').map(part => Number(part.trim()))
    const byte = Math.round(a * 255)
      .toString(16)
      .padStart(2, '0')
    const hex = [r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('')
    return `#${byte}${hex}`.toUpperCase()
  }
  if (/^#[0-9a-fA-F]{6}$/.test(value)) {
    return value.toUpperCase()
  }
  throw new Error(`androidColor cannot express ${value}`)
}

function snake(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/**
 * The native workspace activity is hand-built Kotlin, not React Native, so it
 * cannot import the token module. It reads these resources instead, which makes
 * the night qualifier do the scheme switching and puts the native surface under
 * the same guard as everything else.
 */
export function androidColors(tokens, scheme) {
  const lines = Object.keys(tokens.semantic[scheme]).map(key => {
    const value = androidColor(resolveToken(tokens, scheme, key))
    return `    <color name="aw_${snake(key)}">${value}</color>`
  })
  // XML forbids a double hyphen inside a comment, so the regeneration hint is
  // worded rather than pasted as a command line.
  return `<?xml version="1.0" encoding="utf-8"?>
<!--
  GENERATED FILE, do not edit. Source: tools/dsh-netbird/brand/tokens.json
  Regenerate it by running the brand generator in scripts with its write flag.
  Scheme: ${scheme} (values-night/aw_colors.xml carries the dark one)
-->
<resources>
${lines.join('\n')}
</resources>
`
}

function replaceRegion(source, content, file) {
  const start = source.indexOf(START)
  const end = source.indexOf(END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${file} is missing the ${START} / ${END} markers`)
  }
  return `${source.slice(0, start + START.length)}\n${content}\n${source.slice(end)}`
}

/**
 * The desktop shell's stylesheet, generated whole.
 *
 * The shell follows the OS scheme through `prefers-color-scheme` and takes an
 * explicit `data-scheme` override, because a person who sets their Mac to dark
 * must not have to set a second preference in this app. Both palettes ship every
 * key, so a rule can never reference a colour that exists in only one scheme.
 */
export function shellTokens(tokens) {
  const light = cssColorTokens(tokens, 'light')
  const dark = cssColorTokens(tokens, 'dark')
  const scale = cssScaleTokens(tokens)
  const indented = (block, prefix) =>
    block
      .split('\n')
      .map(line => `${prefix}${line}`)
      .join('\n')
  return `/*
 * Anywhere Work design tokens for the desktop shell.
 *
 * GENERATED FILE - do not edit. The source of truth is
 * tools/dsh-netbird/brand/tokens.json; regenerate with
 * \`node scripts/dsh-netbird-brand.mjs --write\` and let the brand check prove
 * every surface still agrees.
 */
:root {
${light}
${scale}
  color-scheme: light;
}

/* The Mac's scheme is the default; an explicit choice wins over it. */
@media (prefers-color-scheme: dark) {
  :root:not([data-scheme='light']) {
${indented(dark, '  ')}
    color-scheme: dark;
  }
}

:root[data-scheme='dark'] {
${dark}
  color-scheme: dark;
}

:root[data-scheme='light'] {
  color-scheme: light;
}
`
}

/**
 * The same tokens as data, for the shell's main process.
 *
 * The main process needs a colour before any stylesheet exists (the window's own
 * background, so there is no flash of the wrong scheme). It must not import this
 * generator to get it: an application cannot depend on a build script, and a
 * repository-relative import does not survive being packaged. So the value is
 * generated next to the stylesheet that already carries it.
 */
export function shellTokensJson(tokens) {
  const scheme = name => tokens.semantic[name]
  return `${JSON.stringify(
    {
      $comment:
        'GENERATED FILE, do not edit. Source: tools/dsh-netbird/brand/tokens.json (node scripts/dsh-netbird-brand.mjs --write).',
      product: {
        name: tokens.product.name,
        nameZh: tokens.product.nameZh,
        tagline: tokens.product.tagline,
      },
      light: scheme('light'),
      dark: scheme('dark'),
      space: tokens.space,
      radius: tokens.radius,
    },
    null,
    2,
  )}\n`
}

/**
 * The brand's mark and lockup, carried into the shell verbatim.
 *
 * The shell cannot reach into another surface's directory at runtime - it ships as an
 * application - so the canonical files are copied by generation and covered by the same
 * drift check. Hand-copying them is how one surface ends up with last year's logo.
 */
/**
 * The product's own words, as a script the renderer loads.
 *
 * The renderer is a `file://` page with a strict CSP, so it cannot fetch a JSON token
 * file. Generating a plain script keeps the copy in one place instead of typing the
 * product name into the markup, where it would silently outlive a rename.
 */
export function shellBrandScript(tokens) {
  const body = {
    name: tokens.product.name,
    nameZh: tokens.product.nameZh,
    tagline: tokens.product.tagline,
  }
  return `/*
 * GENERATED FILE, do not edit. Source: tools/dsh-netbird/brand/tokens.json
 * (node scripts/dsh-netbird-brand.mjs --write).
 */
globalThis.AWBrand = ${JSON.stringify(body, null, 2)};
`
}

/**
 * The app icon, composed from the brand's own artwork.
 *
 * macOS applies the rounded-rectangle mask itself, so the artwork must be a full-bleed
 * square: pre-rounding it means the system masks it twice and the icon reads small and
 * soft-edged. The glyph is the mark the other surfaces use, placed inside the margin the
 * platform's icon grid keeps for content.
 */
export function appIconSvg(tokens, root = ROOT) {
  // The macOS icon is the phone's icon, composed from the same layers the Android client
  // ships.
  //
  // Android declares an adaptive icon - a background layer and a foreground layer on a
  // 108dp canvas of which the centre 72dp is what a launcher shows - so the mac icon is
  // that visible region, cropped and rounded. Nothing is redrawn and no colour is chosen
  // here: earlier attempts did exactly that (a white ring on a blue ground; the rounding
  // removed altogether) and both were the shell overruling the brand.
  //
  // The layers are referenced rather than embedded, so the generated file stays readable
  // and a change to the phone's artwork reaches this icon too.
  const layers = '../../netbird-client/android/app/src/main/res/mipmap-xxxhdpi'
  const visible = 72
  const canvas = 108
  const inset = (visible - canvas) / 2
  // A rounded square, at the radius the phone's own launcher icon uses.
  const radius = (visible * 0.225).toFixed(2)
  const size = 1024
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${visible} ${visible}" width="${size}" height="${size}">
  <defs>
    <clipPath id="shape"><rect width="${visible}" height="${visible}" rx="${radius}" ry="${radius}"/></clipPath>
  </defs>
  <g clip-path="url(#shape)">
    <image href="${layers}/ic_launcher_background.png" x="${inset}" y="${inset}" width="${canvas}" height="${canvas}"/>
    <image href="${layers}/ic_launcher_foreground.png" x="${inset}" y="${inset}" width="${canvas}" height="${canvas}"/>
  </g>
</svg>
`
}

/** Every generated artifact, as {file, content}. Pure: reads only the tokens. */
export function renderPlan(tokens) {
  return [
    { file: LANDING, region: true, content: landingTokens(tokens) },
    { file: APP_THEME, region: false, content: appThemeModule(tokens) },
    { file: CONSOLE_CSS, region: true, content: consoleTokens(tokens) },
    { file: ANDROID_LIGHT, region: false, content: androidColors(tokens, 'light') },
    { file: ANDROID_DARK, region: false, content: androidColors(tokens, 'dark') },
    { file: SHELL_TOKENS, region: false, content: shellTokens(tokens) },
    { file: SHELL_TOKENS_JSON, region: false, content: shellTokensJson(tokens) },
    { file: SHELL_BRAND_JS, region: false, content: shellBrandScript(tokens) },
    { file: SHELL_APP_ICON, region: false, content: appIconSvg(tokens) },
  ]
}

/** Compare the committed artifacts against the tokens. Returns a problem list. */
export function checkBrand(tokens = loadTokens(), root = ROOT) {
  const problems = []
  const plan = renderPlan(tokens)
  for (const entry of plan) {
    const path = join(root, entry.file)
    if (!existsSync(path)) {
      problems.push(`${entry.file}: missing`)
      continue
    }
    const source = readFileSync(path, 'utf8')
    let expected
    try {
      expected = entry.region ? replaceRegion(source, entry.content, entry.file) : entry.content
    } catch (error) {
      problems.push(`${entry.file}: ${error.message}`)
      continue
    }
    if (source !== expected) {
      problems.push(
        `${entry.file}: out of date with tools/dsh-netbird/brand/tokens.json` +
          ' (run: node scripts/dsh-netbird-brand.mjs --write)',
      )
    }
  }
  return problems
}

export function writeBrand(tokens = loadTokens(), root = ROOT) {
  const written = []
  // The copies travel with the generated tokens: both are derived from the same
  // source and both are covered by the drift check.
  for (const entry of renderPlan(tokens)) {
    const path = join(root, entry.file)
    // A whole-file consumer may not exist yet (the Android colour resources are
    // generated from nothing), so the first run creates it.
    const exists = existsSync(path)
    const source = exists ? readFileSync(path, 'utf8') : ''
    const next = entry.region ? replaceRegion(source, entry.content, entry.file) : entry.content
    if (!exists || source !== next) {
      writeFileSync(path, next)
      written.push(entry.file)
    }
  }
  return written
}

// `pathToFileURL` rather than string-concatenating `file://`: the concatenated
// form puts a relative argv[1] into the URL's host and throws on darwin, which
// breaks every consumer that imports this module from a host whose argv[1] is not
// an absolute path (Electron, for one).
const invokedDirectly = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false
if (invokedDirectly) {
  const write = process.argv.includes('--write')
  if (write) {
    const written = writeBrand()
    console.log(written.length ? `updated:\n  ${written.join('\n  ')}` : 'already up to date')
  } else {
    const problems = checkBrand()
    if (problems.length) {
      console.error(`brand tokens out of date:\n  ${problems.join('\n  ')}`)
      process.exit(1)
    }
    console.log('brand tokens are in sync across every surface')
  }
}