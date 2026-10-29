import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  checkFleetConfig,
  dshZoneOfPattern,
  loadFleetConfig,
  repoRoot,
  renderFleetConfig,
  setPlistString,
} from './render-fleet-config.mjs';

test('the committed fleet config renders without drift', () => {
  assert.deepEqual(checkFleetConfig(), []);
});

test('the config names the defaults every client carries', () => {
  const facts = loadFleetConfig();
  assert.equal(facts.mode, 'cloud');
  assert.match(facts.managementUrl, /^https:\/\//);
  assert.ok(facts.cloudDomain.includes('.'));
  assert.ok(facts.cloudHostSuffixes.length > 0);
  assert.match(facts.updateBaseUrl, /\/$/);
  assert.match(facts.manifestUrl, /\/version\.json$/);
  assert.equal(facts.zone, 'netbird');
});

test('each client gets the bootstrap origins it can reach', () => {
  const rendered = renderFleetConfig();
  const ts = rendered['tools/netbird-client/src/generated/fleetConfig.ts'];
  const mjs = rendered['tools/anywhere-agent/src/generated/fleetConfig.mjs'];
  // The phone's netstack resolver does not answer overlay names before the
  // tunnel is up, so its overlay fallback is a literal address; the desktop
  // proxy resolves the overlay name.
  assert.match(ts, /http:\/\/\d+\.\d+\.\d+\.\d+\/fleet\.json/);
  assert.match(mjs, /http:\/\/tx\.vpn\/fleet\.json/);
  assert.doesNotMatch(ts, /tx\.vpn\/fleet\.json/);
  assert.match(mjs, /http:\/\/tx\.vpn\/fleet\.json/);
});

test('the generated XML and plist carry the cloud domain', () => {
  const rendered = renderFleetConfig();
  assert.match(rendered['tools/netbird-client/android/app/src/main/res/values/fleet_cloud_config.xml'], /fleet_cloud_dns_domain/);
  const plist = readFileSync(join(repoRoot, 'tools/netbird-client/ios/NetBirdPortal/Info.plist'), 'utf8');
  assert.match(plist, /<key>AWCloudDnsDomain<\/key>/);
  assert.match(rendered['tools/netbird-client/ios/NetBirdPortal/Info.plist'], /<key>AWCloudDnsDomain<\/key>/);
});

test('a plist helper replaces one key without touching the rest', () => {
  const plist = '<key>A</key><string>x</string><key>B</key><string>y</string>';
  assert.equal(setPlistString(plist, 'B', 'z'), '<key>A</key><string>x</string><key>B</key><string>z</string>');
});

test('the zone is derived from the inventory pattern', () => {
  assert.equal(dshZoneOfPattern('dsh.<netbird-machine-name>.netbird'), 'netbird');
  assert.throws(() => dshZoneOfPattern('dsh.example.com'));
});
