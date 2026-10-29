import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOTSTRAP_CONFIG_URLS,
  ENDPOINT_RETRY_MS,
  PLACEHOLDER_MANAGEMENT_URL,
  endpointFromEngineConfig,
  endpointHostLabel,
  endpointIsUsable,
  loadBootstrapEndpoint,
  mergeBootstrapDocument,
  normalizeEndpoint,
  resolveEndpoint,
  shouldRetryEndpointDiscovery,
  DEFAULT_MANAGEMENT_URL,
  isCloudManagement,
} from '../src/endpoint.mjs';

test('the placeholder is not an address', () => {
  // Dialling it is the failure this module exists to prevent: the name does not
  // resolve, so the window spends a minute on "connecting" and then reports an engine
  // error that never says which server it meant.
  assert.equal(endpointIsUsable(PLACEHOLDER_MANAGEMENT_URL), false);
  assert.equal(endpointIsUsable(`${PLACEHOLDER_MANAGEMENT_URL}/`), false);
  assert.equal(endpointIsUsable(''), false);
  assert.equal(endpointIsUsable('   '), false);
  assert.equal(endpointIsUsable(undefined), false);
  assert.equal(endpointIsUsable('netbird.corp.example'), false, 'no scheme is not an address to dial');
  assert.equal(endpointIsUsable('https://netbird.corp.example:443'), true);
});

test('a config that carries the placeholder records an attempt, not an enrollment', () => {
  // The live shape: an older build wrote the placeholder into the user's own engine
  // config. Reading it as an enrolled address would keep that machine broken forever,
  // because the enrolled address outranks the package default.
  const poisoned = {
    ManagementURL: { Scheme: 'https', Host: 'netbird.example.com:443' },
    PrivateKey: 'x',
  };
  assert.equal(endpointFromEngineConfig(poisoned), '');
  const enrolled = { ManagementURL: { Scheme: 'https', Host: 'netbird.corp.example:443' } };
  assert.equal(endpointFromEngineConfig(enrolled), 'https://netbird.corp.example:443');
  assert.equal(endpointFromEngineConfig(null), '');
  assert.equal(endpointFromEngineConfig({}), '');
});

test('an explicit source decides, in order', () => {
  const all = {
    flag: 'https://from-flag.example:443',
    env: 'https://from-env.example:443',
    choice: 'https://from-choice.example:443',
    engine: 'https://from-engine.example:443',
    bundled: 'https://from-bundle.example:443',
    seed: 'https://from-channel.example:443',
  };
  assert.equal(resolveEndpoint(all).source, 'flag');
  delete all.flag;
  assert.equal(resolveEndpoint(all).source, 'environment');
  delete all.env;
  assert.equal(resolveEndpoint(all).source, 'choice');
  delete all.choice;
  assert.equal(resolveEndpoint(all).source, 'enrolled');
  delete all.engine;
  assert.equal(resolveEndpoint(all).source, 'bundled');
  delete all.bundled;
  assert.equal(resolveEndpoint(all).source, 'channel');
  delete all.seed;
  assert.equal(resolveEndpoint(all).source, 'default');
  assert.equal(resolveEndpoint(all).url, DEFAULT_MANAGEMENT_URL);
});

test('an enrolled machine is not moved by a newer package default', () => {
  const decided = resolveEndpoint({
    engine: 'https://netbird.corp.example:443',
    bundled: 'https://netbird.other.example:443',
  });
  assert.equal(decided.url, 'https://netbird.corp.example:443');
  assert.equal(decided.source, 'enrolled');
});

test('a build with no deployment value defaults to NetBird Cloud', () => {
  const decided = resolveEndpoint({});
  assert.equal(decided.url, DEFAULT_MANAGEMENT_URL);
  assert.equal(decided.defaultUrl, DEFAULT_MANAGEMENT_URL);
  assert.equal(decided.source, 'default');
  assert.equal(decided.isCustom, false);
  assert.equal(isCloudManagement(decided.url), true);
  assert.equal(isCloudManagement('https://netbird.corp.example:443'), false);
  // An address the user typed themselves is marked, which is what the mobile client
  // shows as its own "（自建）" badge.
  const typed = resolveEndpoint({ choice: 'https://netbird.mine.example:443', bundled: 'https://netbird.corp.example:443' });
  assert.equal(typed.isCustom, true);
  assert.equal(typed.defaultUrl, 'https://netbird.corp.example:443');
  const equal = resolveEndpoint({ choice: 'https://netbird.corp.example:443', bundled: 'https://netbird.corp.example:443' });
  assert.equal(equal.isCustom, false);
});

test('the channel document is read, and never trusted beyond an address', () => {
  assert.deepEqual(mergeBootstrapDocument({ managementUrl: 'https://netbird.corp.example:443/' }), {
    managementUrl: 'https://netbird.corp.example:443',
  });
  assert.equal(mergeBootstrapDocument({ managementUrl: PLACEHOLDER_MANAGEMENT_URL }), null);
  assert.equal(mergeBootstrapDocument({ managementUrl: 'not a url' }), null);
  assert.equal(mergeBootstrapDocument({}), null);
  assert.equal(mergeBootstrapDocument(null), null);
  assert.equal(mergeBootstrapDocument([]), null);
});

test('a bootstrap origin that fails hands over to the next one', async () => {
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(url);
    if (tried.length === 1) {
      throw new Error('offline');
    }
    return { ok: true, text: async () => JSON.stringify({ managementUrl: 'https://netbird.corp.example:443' }) };
  };
  assert.equal(await loadBootstrapEndpoint(fetchImpl), 'https://netbird.corp.example:443');
  assert.deepEqual(tried, BOOTSTRAP_CONFIG_URLS.slice(0, 2));
});

test('an unreachable channel is a normal offline condition', async () => {
  const fetchImpl = async () => {
    throw new Error('offline');
  };
  assert.equal(await loadBootstrapEndpoint(fetchImpl), '');
  // The environment always has a fetch in Node 22, so "no fetch at all" is staged
  // rather than assumed: without it the call would leave this test to the network.
  const globalFetch = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    assert.equal(await loadBootstrapEndpoint(undefined), '', 'no fetch in the environment is not a crash');
  } finally {
    globalThis.fetch = globalFetch;
  }
});

test('addresses are shown as the host a person recognises', () => {
  // The URL API drops a default port, which is the display we want: the row says the
  // name a person recognises rather than the number that carries no information.
  assert.equal(endpointHostLabel('https://netbird.corp.example:443'), 'netbird.corp.example');
  assert.equal(endpointHostLabel('https://netbird.corp.example:9443'), 'netbird.corp.example:9443');
  assert.equal(endpointHostLabel(''), '');
  assert.equal(normalizeEndpoint('  https://a.example/  '), 'https://a.example');
});
test('a launch-time miss on the channel document is retried only while nothing is dialable', () => {
  const now = 10_000_000;
  assert.equal(shouldRetryEndpointDiscovery({ hasEndpoint: false, lastAttemptAt: now - ENDPOINT_RETRY_MS, now }), true);
  assert.equal(shouldRetryEndpointDiscovery({ hasEndpoint: false, lastAttemptAt: now - 1_000, now }), false);
  // An install that already has an address must not be re-pointed by a document: the
  // enrolled identity outranks the channel.
  assert.equal(shouldRetryEndpointDiscovery({ hasEndpoint: true, lastAttemptAt: 1, now }), false);
  assert.equal(shouldRetryEndpointDiscovery({ hasEndpoint: false, lastAttemptAt: 0, now }), false);
});
