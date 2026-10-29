import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  FLEET_ZONES_PATH,
  FORBIDDEN_INVENTORY_PATH,
  IOS_INFO_PLIST_PATH,
  MACHINES_PATH,
  SECURITY_CONFIG_PATH,
  checkMobileRegistry,
  parseInventory,
  parseIosCleartextZones,
  parseIosFleetZones,
  zoneOfPattern,
} from './dsh-netbird-mobile-registry.mjs'

const root = new URL('..', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')

const real = {
  machinesJsonText: read(MACHINES_PATH),
  fleetZonesXml: read(FLEET_ZONES_PATH),
  securityConfigXml: read(SECURITY_CONFIG_PATH),
  iosInfoPlist: read(IOS_INFO_PLIST_PATH),
  compiledInventoryExists: existsSync(new URL(FORBIDDEN_INVENTORY_PATH, root)),
}

test('the shipped fleet inventory and the compiled zone agree', () => {
  assert.deepEqual(checkMobileRegistry(real), [])
})

test('the app ships no machine list', () => {
  // The whole point of the runtime rule: adding a machine is a NetBird-side
  // change, so nothing in the APK enumerates machines.
  assert.equal(real.compiledInventoryExists, false)
  for (const source of [real.fleetZonesXml, real.securityConfigXml, real.iosInfoPlist]) {
    assert.doesNotMatch(source, /dsh\.[a-z0-9-]+\.netbird/, 'no canonical machine name may be compiled in')
  }
})

test('the inventory pattern and its shared zone are read from the file itself', () => {
  const { pattern, machines } = parseInventory(real.machinesJsonText)
  assert.ok(machines.size > 0)
  assert.equal(zoneOfPattern(pattern), 'netbird')
  for (const [machine, domain] of machines) {
    assert.equal(domain, pattern.replace('<netbird-machine-name>', machine))
  }
})

test('a renamed machine needs no app change, but a renamed zone is reported', () => {
  // Renaming a machine keeps the pattern, so nothing compiled in has to change.
  const renamed = real.machinesJsonText
    .replace('"netbirdName": "studio-mac"', '"netbirdName": "leo-laptop"')
    .replace('"domain": "dsh.studio-mac.netbird"', '"domain": "dsh.leo-laptop.netbird"')
  assert.notEqual(renamed, real.machinesJsonText)
  assert.deepEqual(checkMobileRegistry({ ...real, machinesJsonText: renamed }), [])

  // Renaming the zone invalidates both compiled resources at once.
  const moved = real.machinesJsonText.replaceAll('.netbird', '.mesh')
  const problems = checkMobileRegistry({ ...real, machinesJsonText: moved })
  assert.ok(problems.some(problem => problem.includes(FLEET_ZONES_PATH)), problems.join('\n'))
  assert.ok(problems.some(problem => problem.includes(SECURITY_CONFIG_PATH)), problems.join('\n'))
  // iOS carries the same two facts in its own build-time form, and it must be gated by
  // the same rename - otherwise phones would discover nothing on one platform only.
  assert.ok(problems.some(problem => problem.includes(IOS_INFO_PLIST_PATH)), problems.join('\n'))
})

test('the iOS build declares the same zone and cleartext exception', () => {
  const zones = parseIosFleetZones(real.iosInfoPlist)
  assert.deepEqual(zones, ['netbird'], 'exactly the shared zone, like the Android resource')
  assert.ok(parseIosCleartextZones(real.iosInfoPlist).includes('netbird'), 'the zone is reachable over http')
})

test('an iOS plist that loses the zone is reported', () => {
  const withoutZone = real.iosInfoPlist.replace('<string>netbird</string>', '<string>mesh</string>')
  assert.notEqual(withoutZone, real.iosInfoPlist)
  const problems = checkMobileRegistry({ ...real, iosInfoPlist: withoutZone })
  assert.ok(problems.some(problem => problem.includes('AWFleetDshZones')), problems.join('\n'))
})

test('an iOS plist without the cleartext exception is reported', () => {
  const withoutException = real.iosInfoPlist.replace('<key>NSExceptionDomains</key>', '<key>NSExceptionDomainsRenamed</key>')
  const problems = checkMobileRegistry({ ...real, iosInfoPlist: withoutException })
  assert.ok(
    problems.some(problem => problem.includes('missing cleartext exception')),
    problems.join('\n'),
  )
})

test('a machine whose domain drifts from the pattern is reported', () => {
  const machinesJsonText = real.machinesJsonText.replace('"domain": "dsh.studio-mac.netbird"', '"domain": "dsh.studio-mac"')
  const problems = checkMobileRegistry({ ...real, machinesJsonText })
  assert.ok(problems.some(problem => problem.includes('domainPattern')), problems.join('\n'))
})

test('a cleartext config without the shared zone is reported', () => {
  const securityConfigXml = real.securityConfigXml.replace('>netbird</domain>', '>retired-zone</domain>')
  const problems = checkMobileRegistry({ ...real, securityConfigXml })
  assert.ok(problems.some(problem => problem.includes(SECURITY_CONFIG_PATH)), problems.join('\n'))
})

test('a compiled machine list coming back is reported', () => {
  const problems = checkMobileRegistry({ ...real, compiledInventoryExists: true })
  assert.deepEqual(problems, [
    `${FORBIDDEN_INVENTORY_PATH}: the compiled machine list must not come back; ` +
      `entries are discovered from the control plane per ${MACHINES_PATH}`,
  ])
})