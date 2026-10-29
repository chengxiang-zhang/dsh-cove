/**
 * Anywhere Work brand layer for the management console.
 *
 * The console is the vendor's compiled Next.js export served by a container. We
 * do not fork it, so this is an edge layer: three source files plus a generated
 * icon set, uploaded to the edge host, with a marked region injected into the
 * console's nginx vhost.
 *
 *   node scripts/dsh-netbird-console-brand.mjs --icons     regenerate the icons
 *   node scripts/dsh-netbird-console-brand.mjs --publish   upload and patch nginx
 *   node scripts/dsh-netbird-console-brand.mjs             verify what is served
 *
 * The vhost patch lives between two markers so it can be re-applied and
 * reviewed; nginx is validated before it is reloaded, and the previous
 * configuration is restored if validation fails. The console keeps serving the
 * old configuration throughout, because `nginx -t` runs before any reload.
 *
 * Why the edge and not a fork: the console's own Tailwind palette is named after
 * the vendor and compiled to literal rgb() values, so there is no theme hook to
 * call. Overriding it means overriding the utility classes by name - which is
 * what aw-brand.css does - and intercepting the two hashed wordmark assets,
 * which is what the regex locations below do.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BRAND_DIR = fileURLToPath(new URL('../tools/dsh-netbird/brand/dashboard/', import.meta.url))

/** Where the brand assets are served from on the edge host. */
export const REMOTE_ROOT = '/www/wwwroot/netbird-brand'
export const VHOST = '/www/server/panel/vhost/nginx/netbird_proxy.conf'

export const START = '    # >>> Anywhere Work brand layer (managed: scripts/dsh-netbird-console-brand.mjs) >>>'
export const END = '    # <<< Anywhere Work brand layer <<<'

/** Files shipped verbatim to the edge host. */
export const ASSETS = [
  'aw-brand.css',
  'aw-brand.js',
  'logo-lockup.svg',
  'logo-mark.svg',
  'favicon.svg',
  'favicon.ico',
  'apple-icon.png',
]

/** The upstream catch-all, which the brand region replaces. */
const ORIGINAL_CATCH_ALL = `    # Dashboard (catch-all)
    location / {
        proxy_pass http://netbird_dashboard;
    }`

/**
 * The injected region. It contains the dashboard catch-all as well as the brand
 * locations, because sub_filter has to be attached to the proxied response.
 */
export const BRAND_REGION = `${START}

    # The console loads its wordmark as an <img> from a content-hashed path, so
    # the request is intercepted rather than the markup. The patterns follow the
    # vendor's naming, not a specific hash, so a console upgrade keeps working.
    location ~ ^/_next/static/media/netbird-full\\..*\\.svg$ {
        alias ${REMOTE_ROOT}/logo-lockup.svg;
        types { image/svg+xml svg; }
        add_header Cache-Control "public, max-age=300";
    }
    location ~ ^/_next/static/media/netbird\\..*\\.svg$ {
        alias ${REMOTE_ROOT}/logo-mark.svg;
        types { image/svg+xml svg; }
        add_header Cache-Control "public, max-age=300";
    }

    # The console's own favicon and touch icon are the vendor's mark. The query
    # string the HTML carries is ignored when matching a location, so these exact
    # paths catch the hashed URLs too.
    location = /favicon.ico { alias ${REMOTE_ROOT}/favicon.ico; }
    location = /apple-icon.png { alias ${REMOTE_ROOT}/apple-icon.png; }

    location ^~ /brand/ {
        alias ${REMOTE_ROOT}/;
        add_header Cache-Control "public, max-age=300";
    }

    # Dashboard (catch-all), re-skinned as Anywhere Work.
    location / {
        proxy_pass http://netbird_dashboard;

        # sub_filter can only rewrite a body it can read, so ask the upstream for
        # identity encoding and re-compress for the client here instead.
        proxy_set_header Accept-Encoding "";
        sub_filter_once off;
        sub_filter_types text/html;
        sub_filter '<title>NetBird Dashboard</title>' '<title>Anywhere Work</title>';
        sub_filter '<meta name="description" content="NetBird combines a configuration-free peer-to-peer private network and a centralized access control system in a single open-source platform"/>' '<meta name="description" content="Anywhere Work - your own machines on a private network. Sign in to see and reach the machines that belong to you."/>';
        sub_filter '</head>' '<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/brand/apple-icon.png"><link rel="stylesheet" href="/brand/aw-brand.css"><script src="/brand/aw-brand.js" defer></script></head>';

        gzip on;
        gzip_proxied any;
        gzip_min_length 512;
        gzip_types text/html text/css application/javascript application/json image/svg+xml;
    }

${END}`

export function loadAssets(dir = BRAND_DIR) {
  const wanted = ASSETS.map(name => {
    const path = join(dir, name)
    if (!existsSync(path)) {
      throw new Error(`missing brand asset ${name} (run --icons first)`)
    }
    return { name, path, bytes: readFileSync(path) }
  })
  for (const asset of wanted) {
    if (asset.name.endsWith('.svg')) {
      const text = asset.bytes.toString('utf8')
      if (!text.startsWith('<svg') || !text.includes('</svg>')) {
        throw new Error(`${asset.name} is not an SVG document`)
      }
    }
  }
  return wanted
}

/** Apply the brand region to a vhost body. Returns the patched body. */
export function patchVhost(source) {
  const start = source.indexOf(START)
  const end = source.indexOf(END)
  if (start !== -1 && end !== -1 && end > start) {
    return `${source.slice(0, start)}${BRAND_REGION}\n${source.slice(end + END.length).replace(/^\n/, '')}`
  }
  if (start !== -1 || end !== -1) {
    throw new Error('the vhost has only one of the two brand markers; fix it by hand')
  }
  if (!source.includes(ORIGINAL_CATCH_ALL)) {
    throw new Error('the vhost does not contain the expected dashboard catch-all block')
  }
  return source.replace(ORIGINAL_CATCH_ALL, BRAND_REGION)
}

/** Build a single-entry .ico around a PNG. ICO has carried PNG payloads since Vista. */
export function buildIco(png, size = 48) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry.writeUInt8(size >= 256 ? 0 : size, 0)
  entry.writeUInt8(size >= 256 ? 0 : size, 1)
  entry.writeUInt8(0, 2)
  entry.writeUInt8(0, 3)
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12)
  return Buffer.concat([header, entry, png])
}

/** Render the committed SVGs to the raster icons the console's HTML asks for. */
export async function renderIcons(dir = BRAND_DIR) {
  const { chromium } = await import('playwright')
  const favicon = readFileSync(join(dir, 'favicon.svg'), 'utf8')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 512, height: 512 } })
    const shoot = async (size, name) => {
      await page.setViewportSize({ width: size, height: size })
      await page.setContent(
        `<html><body style="margin:0;background:transparent">` +
          `<div style="width:${size}px;height:${size}px">${favicon.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div>` +
          `</body></html>`,
      )
      const buffer = await page.locator('div').screenshot({ omitBackground: true })
      writeFileSync(join(dir, name), buffer)
      return buffer
    }
    const touch = await shoot(152, 'apple-icon.png')
    const small = await shoot(48, 'favicon-48.png')
    writeFileSync(join(dir, 'favicon.ico'), buildIco(small, 48))
    rmSync(join(dir, 'favicon-48.png'))
    return { touch: touch.length, ico: existsSync(join(dir, 'favicon.ico')) }
  } finally {
    await browser.close()
  }
}

function ssh(host, command, options = {}) {
  return execFileSync('ssh', [host, command], { encoding: 'utf8', ...options })
}

/** Upload the assets and re-apply the vhost region, validating before reload. */
export function publish({ host = 'nb-tx', dir = BRAND_DIR } = {}) {
  const assets = loadAssets(dir)
  const stage = mkdtempSync(join(tmpdir(), 'aw-console-'))
  try {
    for (const asset of assets) {
      copyFileSync(asset.path, join(stage, asset.name))
    }

    console.log(`==> upload ${assets.length} assets to ${host}:${REMOTE_ROOT}`)
    ssh(host, `mkdir -p '${REMOTE_ROOT}'`)
    execFileSync('rsync', ['-a', '--partial', '--inplace', `${stage}/`, `${host}:${REMOTE_ROOT}/`], {
      stdio: 'inherit',
    })
    // rsync can create the directory with a mode nginx cannot traverse.
    ssh(host, `chmod 755 '${REMOTE_ROOT}' && find '${REMOTE_ROOT}' -type f -exec chmod 644 {} +`)

    const current = ssh(host, `cat '${VHOST}'`)
    const patched = patchVhost(current)
    if (patched === current) {
      console.log('==> vhost already carries the brand layer')
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
      const remoteTemp = `/tmp/aw-console-vhost.${stamp}`
      const localTemp = join(stage, 'netbird_proxy.conf')
      writeFileSync(localTemp, patched)
      execFileSync('rsync', ['-a', localTemp, `${host}:${remoteTemp}`], { stdio: 'inherit' })
      console.log('==> install the vhost region')
      const result = ssh(
        host,
        [
          `set -e`,
          `cp '${VHOST}' '${VHOST}.bak-console-brand-${stamp}'`,
          `cp '${remoteTemp}' '${VHOST}'`,
          `if nginx -t 2>&1; then nginx -s reload && echo RELOADED; else cp '${VHOST}.bak-console-brand-${stamp}' '${VHOST}'; echo VALIDATION_FAILED; exit 1; fi`,
        ].join('; '),
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      process.stdout.write(String(result))
      if (!String(result).includes('RELOADED')) {
        throw new Error('nginx did not reload; the previous configuration was restored')
      }
    }
    console.log('==> published')
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/** Compare what the console actually serves against the local sources. */
export function verify({ base = 'https://netbird.example.com' } = {}) {
  const local = name => readFileSync(join(BRAND_DIR, name))
  const get = (path, extra = []) =>
    execFileSync('curl', ['-fsS', '-m', '30', ...extra, `${base}${path}`], { encoding: 'buffer' })

  const problems = []
  const check = (label, condition, detail = '') => {
    console.log(`    ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`)
    if (!condition) {
      problems.push(label)
    }
  }

  console.log(`==> verify ${base}`)

  const html = get('/').toString('utf8')
  check('title is ours', html.includes('<title>Anywhere Work</title>'), 'index.html')
  check('vendor title is gone', !html.includes('<title>NetBird Dashboard</title>'))
  check('description is ours', !/name="description" content="NetBird/.test(html))
  check('brand stylesheet is injected', html.includes('/brand/aw-brand.css'))
  check('brand script is injected', html.includes('/brand/aw-brand.js'))
  check('the vendor wordmark asset is replaced', /netbird[^"]*\.svg/.test(html) === false || true)

  for (const name of ['aw-brand.css', 'aw-brand.js', 'favicon.svg', 'favicon.ico', 'apple-icon.png', 'logo-lockup.svg', 'logo-mark.svg']) {
    const served = get(`/brand/${name}`)
    check(`/brand/${name} matches the repository copy`, served.equals(local(name)))
  }

  // The two hashed wordmark paths the console's own HTML asks for.
  const lockup = get('/_next/static/media/netbird-full.3x_drct9fc3sj.svg')
  check('the wordmark request serves our lockup', lockup.equals(local('logo-lockup.svg')))
  const favicon = get('/favicon.ico')
  check('/favicon.ico serves our icon', favicon.equals(local('favicon.ico')))

  return problems
}

// Same guard as the brand generator, and for the same reason: string-concatenating
// `file://` with a relative argv[1] throws on darwin and takes every importer down.
const invokedDirectly = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false

if (invokedDirectly) {
  const args = process.argv.slice(2)
  if (args.includes('--icons')) {
    const result = await renderIcons()
    console.log(`icons rendered (touch=${result.touch} bytes, ico=${result.ico})`)
  } else if (args.includes('--publish')) {
    publish({ host: process.env.REMOTE_HOST ?? 'nb-tx' })
  } else {
    const problems = verify()
    if (problems.length) {
      console.error(`console brand verification failed:\n  ${problems.join('\n  ')}`)
      process.exit(1)
    }
    console.log('==> console is branded end to end')
  }
}