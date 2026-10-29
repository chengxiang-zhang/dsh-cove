#!/usr/bin/env node
/**
 * Self-hosted control-plane contract guardrail.
 *
 * `tools/dsh-netbird/self-hosted.md` tells an operator how to stand up their own
 * NetBird control plane so the shipped clients (desktop one-liner and Android
 * app) can use it, and `tools/dsh-netbird/selfhosted/` holds the templates for
 * the configuration that used to live only on the fleet's own server.
 *
 * Two failure modes make that page worthless, and neither is visible by reading
 * it:
 *
 * - the custom DNS zone drifts from the zone the app compiles
 *   (`res/values/fleet_dsh_zones.xml`), which is what `pnpm
 *   dsh-netbird:mobile-registry` guards for the fleet inventory. The template
 *   needs the same guard, because a BYO operator copies the template;
 * - the page and the templates drift apart — a template nobody links, a fact the
 *   translation lost, or the publish script growing a hardcoded control plane
 *   that no longer matches the zone it ships.
 *
 * Usage:
 *   node scripts/dsh-netbird-selfhost-templates.mjs           # check, non-zero on drift
 *   node scripts/dsh-netbird-selfhost-templates.mjs --json    # machine-readable result
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { FLEET_ZONES_PATH, MACHINES_PATH, parseInventory, zoneOfPattern } from './dsh-netbird-mobile-registry.mjs'
import { sigEqual, signature } from './verify-docs.mjs'

export const SELFHOSTED_DIR = 'tools/dsh-netbird/selfhosted'
export const SERVER_CONFIG_TEMPLATE = `${SELFHOSTED_DIR}/netbird-server-config.yaml.template`
export const IDP_CONNECTOR_TEMPLATE = `${SELFHOSTED_DIR}/idp-dex-connector.yaml.template`
export const DASHBOARD_ENV_TEMPLATE = `${SELFHOSTED_DIR}/netbird-dashboard.env.template`
export const PROXY_TEMPLATE = `${SELFHOSTED_DIR}/netbird-proxy.conf.template`
export const CUSTOM_ZONE_TEMPLATE = `${SELFHOSTED_DIR}/custom-zone.json.template`
export const RUNBOOK_EN = 'tools/dsh-netbird/self-hosted.md'
export const RUNBOOK_ZH = 'tools/dsh-netbird/self-hosted.zh.md'
export const PUBLISH_SH = 'tools/netbird-client/scripts/publish.sh'

export const TEMPLATE_FILES = [
  SERVER_CONFIG_TEMPLATE,
  IDP_CONNECTOR_TEMPLATE,
  DASHBOARD_ENV_TEMPLATE,
  PROXY_TEMPLATE,
  CUSTOM_ZONE_TEMPLATE,
]

/**
 * The redirect the app's sign-in ends on. It belongs to the `netbird-cli` client
 * the deployment registers in its own IdP — the app registers nothing, and the
 * IdP connector's own callback is a different value.
 */
export const APP_LOOPBACK_REDIRECT = 'http://localhost:53000/'

const DOCUMENT_FILES = [
  ['self-hosted.md', RUNBOOK_EN],
  ['self-hosted.zh.md', RUNBOOK_ZH],
]

/** One zone, so the template cannot ship a name the app would refuse. */
export function compiledZones(fleetZonesXml) {
  return [...fleetZonesXml.matchAll(/<item>\s*([^<\s]+)\s*<\/item>/g)].map(match => match[1])
}

function checkZoneTemplate(problems, text, zone) {
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    problems.push(`${CUSTOM_ZONE_TEMPLATE} does not parse as JSON: ${error.message}`)
    return
  }
  if (document.domain !== zone) {
    problems.push(
      `${CUSTOM_ZONE_TEMPLATE} declares domain ${document.domain}, but the app compiles zone ${zone}`,
    )
  }
  if (!Array.isArray(document.distribution_groups) || document.distribution_groups.length === 0) {
    problems.push(`${CUSTOM_ZONE_TEMPLATE} needs a distribution_groups list: an undistributed zone yields an empty list`)
  }
  const records = document.records ?? []
  if (records.length === 0) {
    problems.push(`${CUSTOM_ZONE_TEMPLATE} carries no record, so it documents nothing about dsh entries`)
  }
  for (const record of records) {
    const name = String(record.name ?? '')
    if (record.type !== 1) {
      problems.push(`${CUSTOM_ZONE_TEMPLATE} record ${name}: type must be 1 (A)`)
    }
    if (!name.endsWith('.')) {
      problems.push(`${CUSTOM_ZONE_TEMPLATE} record ${name}: the management API stores fully qualified names, so it needs a trailing dot`)
    }
    if (!name.startsWith('dsh.') || !name.includes(`.${zone}.`)) {
      problems.push(`${CUSTOM_ZONE_TEMPLATE} record ${name}: a DSH entry is dsh.<machine>.${zone}`)
    }
    if (record.ttl !== 300) {
      problems.push(`${CUSTOM_ZONE_TEMPLATE} record ${name}: keep the fleet TTL of 300s so changes propagate quickly`)
    }
  }
}

export function checkSelfhostTemplates(input) {
  const { templates, runbookEn, runbookZh, machinesJsonText, fleetZonesXml, publishSh } = input
  const problems = []
  const documents = [['self-hosted.md', runbookEn], ['self-hosted.zh.md', runbookZh]]

  for (const file of TEMPLATE_FILES) {
    const text = templates[file] ?? ''
    if (text.trim() === '') {
      problems.push(`${file} is missing or empty`)
    }
    for (const [label, document] of documents) {
      if (!document.includes(file.split('/').pop())) {
        problems.push(`${label} does not link ${file.split('/').pop()}`)
      }
    }
  }

  const { pattern } = parseInventory(machinesJsonText)
  const zone = zoneOfPattern(pattern)
  const zones = compiledZones(fleetZonesXml)
  if (zones.length !== 1 || zones[0] !== zone) {
    problems.push(`the app compiles zones ${JSON.stringify(zones)}, but the inventory pattern declares ${zone}`)
  }
  checkZoneTemplate(problems, templates[CUSTOM_ZONE_TEMPLATE] ?? '', zone)

  const serverConfig = templates[SERVER_CONFIG_TEMPLATE] ?? ''
  if (!/^\s*localAuthDisabled:\s*true\s*$/m.test(serverConfig)) {
    problems.push(`${SERVER_CONFIG_TEMPLATE} must disable NetBird's own login (localAuthDisabled: true)`)
  }
  const stuns = [...serverConfig.matchAll(/^\s*-\s*(stun:\S+)\s*$/gm)].map(match => match[1])
  if (stuns.length < 3) {
    problems.push(`${SERVER_CONFIG_TEMPLATE} lists ${stuns.length} STUN servers; a single one leaves multi-WAN peers on the relay`)
  }
  if (!stuns.some(stun => stun.includes('__MANAGEMENT_HOST__'))) {
    problems.push(`${SERVER_CONFIG_TEMPLATE} must keep the deployment's own STUN first`)
  }
  if (serverConfig.includes('\t')) {
    problems.push(`${SERVER_CONFIG_TEMPLATE} contains a tab, which YAML forbids`)
  }

  const dashboardEnv = templates[DASHBOARD_ENV_TEMPLATE] ?? ''
  const assignments = dashboardEnv
    .split('\n')
    .filter(line => line.trim() !== '' && !line.trimStart().startsWith('#') && line.includes('='))
  if (assignments.length !== 1 || !assignments[0].startsWith('AUTH_CLIENT_SECRET=__')) {
    problems.push(
      `${DASHBOARD_ENV_TEMPLATE} must carry exactly one placeholder assignment (AUTH_CLIENT_SECRET=__...__), found ${JSON.stringify(assignments)}`,
    )
  }

  const idp = templates[IDP_CONNECTOR_TEMPLATE] ?? ''
  for (const required of [
    'type: oidc',
    'issuer: https://',
    'clientID:',
    'clientSecret:',
    'redirectURI: https://',
    'insecureSkipEmailVerified: true',
    'insecureEnableGroups: true',
  ]) {
    if (!idp.includes(required)) {
      problems.push(`${IDP_CONNECTOR_TEMPLATE} is missing ${required}`)
    }
  }
  // Comments may explain which callback is *not* this one; only configured
  // values count, so comment lines are dropped before the check.
  const configuredIdp = idp
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n')
  if (configuredIdp.includes('localhost:53000')) {
    problems.push(`${IDP_CONNECTOR_TEMPLATE} must not carry the client loopback callback: that belongs to the netbird-cli client, not the connector`)
  }

  const proxy = templates[PROXY_TEMPLATE] ?? ''
  for (const required of [
    'listen 443 ssl;',
    'server_name __MANAGEMENT_HOST__;',
    'location = /nb-auth',
    'location = /nb-silent-auth',
    'location /api/',
    'location /oauth2/',
  ]) {
    if (!proxy.includes(required)) {
      problems.push(`${PROXY_TEMPLATE} is missing ${required}`)
    }
  }
  for (const callback of ['/nb-auth', '/nb-silent-auth']) {
    const block = new RegExp(`location = ${callback} \\{[\\s\\S]{0,240}?index\\.html`)
    if (!block.test(proxy)) {
      problems.push(`${PROXY_TEMPLATE}: ${callback} must return the dashboard shell directly, its export has no SPA fallback`)
    }
  }

  for (const [label, document] of documents) {
    if (!document.includes(APP_LOOPBACK_REDIRECT)) {
      problems.push(`${label} must state the client redirect ${APP_LOOPBACK_REDIRECT}`)
    }
    if (!document.includes('fleet_dsh_zones.xml')) {
      problems.push(`${label} must name the compiled zone resource the app ships`)
    }
    if (!document.includes(zone)) {
      problems.push(`${label} must name the required zone ${zone}`)
    }
  }
  if (!sigEqual(signature(runbookEn), signature(runbookZh))) {
    problems.push(`${RUNBOOK_EN} and ${RUNBOOK_ZH} do not mirror each other (headings, fences, tables, list kinds)`)
  }

  if (!/^MANAGEMENT_URL="\$\{MANAGEMENT_URL:-/m.test(publishSh)) {
    problems.push(`${PUBLISH_SH} must keep the management URL overridable for a deployment that publishes its own channel`)
  }
  const publishZone = /^ZONE="\$\{ZONE:-([^}]+)\}"/m.exec(publishSh)
  if (!publishZone) {
    problems.push(`${PUBLISH_SH} must keep the zone overridable for a deployment that publishes its own channel`)
  } else if (!/--get zone/.test(publishZone[1]) && publishZone[1] !== zone) {
    // A literal zone must equal the compiled one. A rendered value delegates to
    // config/fleet.json, which scripts/render-fleet-config.test.mjs holds to the
    // inventory pattern this check already reads.
    problems.push(`${PUBLISH_SH} publishes zone ${publishZone[1]}, but the app compiles ${zone}`)
  }

  return problems
}

function main() {
  const root = new URL('..', import.meta.url)
  const read = path => readFileSync(new URL(path, root), 'utf8')
  const templates = {}
  for (const file of TEMPLATE_FILES) {
    templates[file] = read(file)
  }
  const problems = checkSelfhostTemplates({
    templates,
    runbookEn: read(RUNBOOK_EN),
    runbookZh: read(RUNBOOK_ZH),
    machinesJsonText: read(MACHINES_PATH),
    fleetZonesXml: read(FLEET_ZONES_PATH),
    publishSh: read(PUBLISH_SH),
  })

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2))
  } else if (problems.length === 0) {
    console.log(`self-hosted contract matches ${SELFHOSTED_DIR} and ${RUNBOOK_EN}`)
  } else {
    for (const problem of problems) {
      console.error(`DRIFT ${problem}`)
    }
  }
  process.exit(problems.length === 0 ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}