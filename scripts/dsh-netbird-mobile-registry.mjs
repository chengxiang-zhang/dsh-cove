#!/usr/bin/env node
/**
 * Mobile DSH contract guardrail.
 *
 * The Android client discovers its DSH entries at runtime: it keeps the `dsh.*`
 * records that live in the fleet's own zone and whose target is a peer of this
 * network. The machine list therefore lives only in
 * `tools/dsh-netbird/machines.json` and is never copied into the app — a second
 * copy can only go stale, and when the fleet moved from `dsh.<machine>` to
 * `dsh.<machine>.netbird` exactly that emptied the catalogue on every phone.
 *
 * Four things are still compiled in, because neither platform can do otherwise:
 *
 * - `res/values/fleet_dsh_zones.xml` — which zones the Android app reads entries from;
 * - `res/xml/network_security_config.xml` — which private zones may use cleartext http
 *   on Android. A network security config is a build-time resource;
 * - `ios/NetBirdPortal/Info.plist` (`AWFleetDshZones`) — the same zone list for iOS;
 * - `ios/NetBirdPortal/Info.plist` (`NSExceptionDomains`) — the cleartext exception
 *   that is the iOS counterpart of the Android network security config. App Transport
 *   Security is a build-time plist; there is no runtime form of it either.
 *
 * This gate keeps all four equal to the zone the inventory's own `domainPattern`
 * declares, so a rename fails a repo check instead of silently breaking clients on
 * every platform.
 *
 * Usage:
 *   node scripts/dsh-netbird-mobile-registry.mjs           # check, non-zero on drift
 *   node scripts/dsh-netbird-mobile-registry.mjs --json    # machine-readable result
 */
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const MACHINES_PATH = 'tools/dsh-netbird/machines.json'
export const FLEET_ZONES_PATH =
  'tools/netbird-client/android/app/src/main/res/values/fleet_dsh_zones.xml'
export const SECURITY_CONFIG_PATH =
  'tools/netbird-client/android/app/src/main/res/xml/network_security_config.xml'
export const IOS_INFO_PLIST_PATH = 'tools/netbird-client/ios/NetBirdPortal/Info.plist'
export const FORBIDDEN_INVENTORY_PATH =
  'tools/netbird-client/android/app/src/main/res/values/authorized_dsh_hosts.xml'

const DOMAIN_PLACEHOLDER = '<netbird-machine-name>'

/** Domain of every machine entry, keyed by machine name, plus the declared pattern. */
export function parseInventory(machinesJsonText) {
  const inventory = JSON.parse(machinesJsonText)
  const pattern = inventory.domainPattern
  if (typeof pattern !== 'string' || !pattern.includes(DOMAIN_PLACEHOLDER)) {
    throw new Error(`${MACHINES_PATH}: domainPattern must contain ${DOMAIN_PLACEHOLDER}`)
  }
  const machines = new Map()
  for (const machine of inventory.machines ?? []) {
    if (!machine?.netbirdName || !machine?.domain) {
      throw new Error(`${MACHINES_PATH}: every machine needs netbirdName and domain`)
    }
    machines.set(machine.netbirdName, machine.domain)
  }
  if (machines.size === 0) {
    throw new Error(`${MACHINES_PATH}: no machines declared`)
  }
  return { pattern, machines }
}

/** The shared zone of the declared domain pattern, for example netbird. */
export function zoneOfPattern(pattern) {
  const zone = pattern.slice(pattern.lastIndexOf(DOMAIN_PLACEHOLDER) + DOMAIN_PLACEHOLDER.length)
  return zone.startsWith('.') ? zone.slice(1) : zone
}

function parseStringArray(xml) {
  return [...xml.matchAll(/<item>\s*([^<\s]+)\s*<\/item>/g)].map(match => match[1])
}

export function parseCleartextZones(securityConfigXml) {
  return [...securityConfigXml.matchAll(/<domain[^>]*>\s*([^<\s]+)\s*<\/domain>/g)].map(match => match[1])
}

/** The `AWFleetDshZones` array an iOS build carries. */
export function parseIosFleetZones(infoPlist) {
  const at = infoPlist.indexOf('<key>AWFleetDshZones</key>')
  if (at === -1) {
    return []
  }
  const array = /<array>([\s\S]*?)<\/array>/.exec(infoPlist.slice(at))
  if (!array) {
    return []
  }
  return [...array[1].matchAll(/<string>\s*([^<\s]+)\s*<\/string>/g)].map(match => match[1])
}

/** The zones an iOS build allows cleartext http for, as ATS exception domains. */
export function parseIosCleartextZones(infoPlist) {
  const at = infoPlist.indexOf('<key>NSExceptionDomains</key>')
  if (at === -1) {
    return []
  }
  const dict = /<dict>([\s\S]*?)<\/dict>\s*<\/dict>/.exec(infoPlist.slice(at))
  const body = dict ? dict[1] : infoPlist.slice(at)
  return [...body.matchAll(/<key>([^<\s]+)<\/key>\s*<dict>/g)].map(match => match[1])
}

/**
 * Returns one message per disagreement between the inventory and the two
 * compiled Android resources. An empty array means they agree.
 */
export function checkMobileRegistry({
  machinesJsonText,
  fleetZonesXml,
  securityConfigXml,
  iosInfoPlist = '',
  compiledInventoryExists = false,
}) {
  const problems = []
  const { pattern, machines } = parseInventory(machinesJsonText)
  const zone = zoneOfPattern(pattern)

  for (const [machine, domain] of machines) {
    const expected = pattern.replace(DOMAIN_PLACEHOLDER, machine)
    if (domain !== expected) {
      problems.push(
        `${MACHINES_PATH}: ${machine} domain is ${domain} but domainPattern ${pattern} requires ${expected}`,
      )
    }
    if (!domain.endsWith(`.${zone}`)) {
      problems.push(`${MACHINES_PATH}: ${machine} domain ${domain} is not inside the shared zone ${zone}`)
    }
  }

  const declaredZones = parseStringArray(fleetZonesXml)
  if (declaredZones.length !== 1 || declaredZones[0] !== zone) {
    problems.push(
      `${FLEET_ZONES_PATH}: expected exactly the zone ${zone} from ${pattern}, got [${declaredZones.join(', ')}]`,
    )
  }

  const cleartextZones = new Set(parseCleartextZones(securityConfigXml))
  if (!cleartextZones.has(zone)) {
    problems.push(`${SECURITY_CONFIG_PATH}: missing cleartext zone ${zone} for ${pattern}`)
  }

  // The iOS build carries the same two facts in its own build-time form. Without this
  // half, a zone rename would leave the phone app discovering nothing on iOS while the
  // Android gate stayed green.
  if (iosInfoPlist !== '') {
    const iosZones = parseIosFleetZones(iosInfoPlist)
    if (iosZones.length !== 1 || iosZones[0] !== zone) {
      problems.push(
        `${IOS_INFO_PLIST_PATH}: AWFleetDshZones expected exactly the zone ${zone} from ${pattern}, got [${iosZones.join(', ')}]`,
      )
    }
    const iosCleartext = new Set(parseIosCleartextZones(iosInfoPlist))
    if (!iosCleartext.has(zone)) {
      problems.push(`${IOS_INFO_PLIST_PATH}: missing cleartext exception for zone ${zone} for ${pattern}`)
    }
  }

  if (compiledInventoryExists) {
    problems.push(
      `${FORBIDDEN_INVENTORY_PATH}: the compiled machine list must not come back; ` +
        `entries are discovered from the control plane per ${MACHINES_PATH}`,
    )
  }

  return problems
}

function main() {
  const root = new URL('..', import.meta.url)
  const read = path => readFileSync(new URL(path, root), 'utf8')
  const problems = checkMobileRegistry({
    machinesJsonText: read(MACHINES_PATH),
    fleetZonesXml: read(FLEET_ZONES_PATH),
    securityConfigXml: read(SECURITY_CONFIG_PATH),
    iosInfoPlist: read(IOS_INFO_PLIST_PATH),
    compiledInventoryExists: existsSync(new URL(FORBIDDEN_INVENTORY_PATH, root)),
  })

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2))
  } else if (problems.length === 0) {
    console.log(`mobile DSH contract matches ${MACHINES_PATH}`)
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