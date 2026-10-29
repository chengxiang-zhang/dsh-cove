import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { UPDATE_RECHECK_MS, checkContract, checkForUpdate, compareVersions, decideUpdate, digestMatches, parseManifest, updateCheckDue } from '../src/update.mjs';

const GOOD = {
  version: '0.2.0',
  url: 'https://anywhere.example/app/AnywhereWork-0.2.0.zip',
  sha256: 'a'.repeat(64),
  minProtocol: 1,
};

test('a well formed manifest is accepted and normalised', () => {
  const result = parseManifest(JSON.stringify({ ...GOOD, sha256: 'A'.repeat(64), notes: 'fixes' }));
  assert.equal(result.ok, true);
  assert.equal(result.manifest.sha256, 'a'.repeat(64), 'digests are compared lower-cased');
  assert.equal(result.manifest.minProtocol, 1);
  assert.equal(result.manifest.notes, 'fixes');
  // An absent minProtocol means no floor rather than a missing field.
  assert.equal(parseManifest({ version: '1.0.0', url: 'https://x/y', sha256: 'b'.repeat(64) }).manifest.minProtocol, 0);
});

test('a manifest that is not one is refused, field by field', () => {
  const cases = [
    ['not json', 'nonsense'],
    ['not an object', [1, 2]],
    ['missing url', { version: '1.0.0', sha256: 'a'.repeat(64) }],
    ['missing sha', { version: '1.0.0', url: 'https://x/y' }],
    ['bad version', { ...GOOD, version: 'latest' }],
    ['plain http', { ...GOOD, url: 'http://x/y' }],
    ['short digest', { ...GOOD, sha256: 'abc' }],
    ['negative protocol', { ...GOOD, minProtocol: -1 }],
  ];
  for (const [label, input] of cases) {
    const result = parseManifest(input);
    assert.equal(result.ok, false, label);
    assert.ok(result.reason.length > 0, label);
  }
});

test('versions compare numerically, including pre-releases', () => {
  assert.ok(compareVersions('0.2.0', '0.1.9') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0, 'ten is not less than nine');
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(compareVersions('0.1.0', '0.1.0-rc.1') > 0, 'a release outranks its pre-release');
  assert.ok(compareVersions('0.1.0-rc.1', '0.1.0-rc.2') < 0);
});

test('an older client refuses an update that needs a newer protocol', () => {
  const decision = decideUpdate({ current: '0.1.0', protocol: 1, manifest: { ...GOOD, minProtocol: 2 } });
  assert.equal(decision.action, 'refuse');
  assert.match(decision.reason, /protocol 1/);
});

test('a newer version is offered, an equal one is not', () => {
  assert.equal(decideUpdate({ current: '0.1.0', protocol: 1, manifest: GOOD }).action, 'available');
  assert.equal(decideUpdate({ current: '0.2.0', protocol: 1, manifest: GOOD }).action, 'none');
  assert.equal(decideUpdate({ current: '0.3.0', protocol: 1, manifest: GOOD }).action, 'none');
  assert.equal(decideUpdate({ current: '0.1.0', protocol: 1, manifest: null }).action, 'none');
});

test('a payload digest is compared without short-circuiting', () => {
  const real = createHash('sha256').update('payload').digest('hex');
  assert.equal(digestMatches(real, real.toUpperCase()), true);
  assert.equal(digestMatches(real, `${'a'.repeat(63)}b`), false);
  assert.equal(digestMatches('', real), false);
  assert.equal(digestMatches(real, ''), false);
});

test('the engine contract is enforced on protocol and engine version', () => {
  const contract = { protocol: 1, netbird: 'v0.78.1', helper: '0.1.1' };
  assert.equal(checkContract({ protocol: 1, netbird: 'v0.78.1' }, contract).ok, true);
  const protocol = checkContract({ protocol: 2, netbird: 'v0.78.1' }, contract);
  assert.equal(protocol.ok, false);
  assert.match(protocol.reason, /protocol 2/);
  const engine = checkContract({ protocol: 1, netbird: 'v0.79.0' }, contract);
  assert.equal(engine.ok, false);
  assert.match(engine.reason, /v0.79.0/);
  assert.equal(checkContract(null, contract).ok, false);
  // Our own patched tree reports build metadata; it must not fail the contract.
  assert.equal(checkContract({ protocol: 1, netbird: 'v0.78.1+dirty' }, contract).ok, true);
});
const respond = (body, ok = true, status = 200) => async () => ({ ok, status, text: async () => body });

test('no channel means no network call at all', async () => {
  let called = 0;
  const result = await checkForUpdate({ channel: '', current: '0.1.0', protocol: 1, fetchImpl: async () => { called += 1; } });
  assert.equal(result.action, 'none');
  assert.equal(called, 0);
});

test('a non-https channel is refused before any request', async () => {
  let called = 0;
  const result = await checkForUpdate({ channel: 'http://x/latest.json', current: '0.1.0', protocol: 1, fetchImpl: async () => { called += 1; } });
  assert.equal(result.action, 'error');
  assert.match(result.reason, /https/);
  assert.equal(called, 0);
});

test('a good channel offers a newer version', async () => {
  const result = await checkForUpdate({
    channel: 'https://anywhere.example/latest.json',
    current: '0.1.0',
    protocol: 1,
    fetchImpl: respond(JSON.stringify(GOOD)),
  });
  assert.equal(result.action, 'available');
  assert.equal(result.manifest.version, '0.2.0');
});

test('channel failures are reported, never silently current', async () => {
  const unreachable = await checkForUpdate({
    channel: 'https://anywhere.example/latest.json',
    current: '0.1.0',
    protocol: 1,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.equal(unreachable.action, 'error');
  assert.match(unreachable.reason, /offline/);

  const badBody = await checkForUpdate({
    channel: 'https://anywhere.example/latest.json',
    current: '0.1.0',
    protocol: 1,
    fetchImpl: respond('not json'),
  });
  assert.equal(badBody.action, 'error');

  const badStatus = await checkForUpdate({
    channel: 'https://anywhere.example/latest.json',
    current: '0.1.0',
    protocol: 1,
    fetchImpl: respond('', false, 503),
  });
  assert.equal(badStatus.action, 'error');
  assert.match(badStatus.reason, /503/);
});

test('a channel that demands a newer protocol is refused, not installed', async () => {
  const result = await checkForUpdate({
    channel: 'https://anywhere.example/latest.json',
    current: '0.1.0',
    protocol: 1,
    fetchImpl: respond(JSON.stringify({ ...GOOD, minProtocol: 3 })),
  });
  assert.equal(result.action, 'refuse');
});

// The app is a tray app: it can stay open for weeks. Its update state used to be read
// once, at launch, and never again, so "up to date" was an answer about the morning the
// window was opened.
test('an update reading is re-asked once it has aged, not on every tick', () => {
  const now = 100_000_000;
  assert.equal(updateCheckDue({ lastCheckedAt: now - UPDATE_RECHECK_MS, now }), true);
  assert.equal(updateCheckDue({ lastCheckedAt: now - 1_000, now }), false);
  assert.equal(
    updateCheckDue({ lastCheckedAt: 0, now }),
    false,
    'launch does its own check; the heartbeat only ages a reading that exists',
  );
  assert.equal(updateCheckDue({ lastCheckedAt: Number.NaN, now }), false);
});
