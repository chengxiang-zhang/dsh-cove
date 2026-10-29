import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  APP_LOOPBACK_REDIRECT,
  CUSTOM_ZONE_TEMPLATE,
  IDP_CONNECTOR_TEMPLATE,
  PUBLISH_SH,
  RUNBOOK_EN,
  RUNBOOK_ZH,
  SERVER_CONFIG_TEMPLATE,
  TEMPLATE_FILES,
  checkSelfhostTemplates,
} from './dsh-netbird-selfhost-templates.mjs'
import { FLEET_ZONES_PATH, MACHINES_PATH } from './dsh-netbird-mobile-registry.mjs'

const root = new URL('..', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')

const real = {
  templates: Object.fromEntries(TEMPLATE_FILES.map(file => [file, read(file)])),
  runbookEn: read(RUNBOOK_EN),
  runbookZh: read(RUNBOOK_ZH),
  machinesJsonText: read(MACHINES_PATH),
  fleetZonesXml: read(FLEET_ZONES_PATH),
  publishSh: read(PUBLISH_SH),
}

const clone = () => ({
  templates: { ...real.templates },
  runbookEn: real.runbookEn,
  runbookZh: real.runbookZh,
  machinesJsonText: real.machinesJsonText,
  fleetZonesXml: real.fleetZonesXml,
  publishSh: real.publishSh,
})

test('the self-hosted templates and the runbook agree with what the app compiles', () => {
  assert.deepEqual(checkSelfhostTemplates(real), [])
})

test('a zone the app cannot read is refused', () => {
  const input = clone()
  input.templates[CUSTOM_ZONE_TEMPLATE] = input.templates[CUSTOM_ZONE_TEMPLATE].replace(
    '"domain": "netbird"',
    '"domain": "corp-netbird"',
  )
  assert.match(checkSelfhostTemplates(input).join('\n'), /the app compiles zone netbird/)
})

test('a record that is not a fully qualified dsh entry is refused', () => {
  const input = clone()
  input.templates[CUSTOM_ZONE_TEMPLATE] = input.templates[CUSTOM_ZONE_TEMPLATE].replace(
    '"dsh.__MACHINE__.netbird."',
    '"dsh.__MACHINE__.netbird"',
  )
  assert.match(checkSelfhostTemplates(input).join('\n'), /trailing dot/)
})

test('the connector never carries the client loopback callback', () => {
  const input = clone()
  input.templates[IDP_CONNECTOR_TEMPLATE] = input.templates[IDP_CONNECTOR_TEMPLATE].replace(
    'redirectURI: https://__MANAGEMENT_HOST__/oauth2/callback',
    `redirectURI: ${APP_LOOPBACK_REDIRECT}`,
  )
  assert.match(checkSelfhostTemplates(input).join('\n'), /must not carry the client loopback callback/)
})

test('a single STUN server is refused', () => {
  const input = clone()
  input.templates[SERVER_CONFIG_TEMPLATE] = input.templates[SERVER_CONFIG_TEMPLATE]
    .replace('    - stun:stun.miwifi.com:3478\n', '')
    .replace('    - stun:stun.l.google.com:19302\n', '')
  assert.match(checkSelfhostTemplates(input).join('\n'), /leaves multi-WAN peers on the relay/)
})

test('a template nobody links is reported', () => {
  const input = clone()
  input.runbookEn = input.runbookEn.replaceAll('netbird-dashboard.env.template', 'dashboard env')
  assert.match(checkSelfhostTemplates(input).join('\n'), /self-hosted\.md does not link netbird-dashboard\.env\.template/)
})

test('a translation that lost a section is reported', () => {
  const input = clone()
  input.runbookZh = input.runbookZh.replace('## 验收\n', '')
  assert.match(checkSelfhostTemplates(input).join('\n'), /do not mirror each other/)
})

test('a publish script that hardcodes the control plane is reported', () => {
  const input = clone()
  input.publishSh = input.publishSh.replace(
    'ZONE="${ZONE:-$(node "$FLEET_CONFIG_RENDER" --get zone)}"',
    'ZONE="netbird"',
  )
  assert.match(checkSelfhostTemplates(input).join('\n'), /must keep the zone overridable/)
})