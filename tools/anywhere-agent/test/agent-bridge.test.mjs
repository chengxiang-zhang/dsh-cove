import test from 'node:test';
import assert from 'node:assert/strict';

import { createClaimState, startAgentBridge, TIERS } from '../src/agent-bridge.mjs';

const TAB = (id) => ({ id, title: id, serviceId: `machine:${id}`, active: false });

test('a claim is attributable and read-only by default', () => {
  const claims = createClaimState({ now: () => 1000 });
  const result = claims.claim('tab-1', { by: 'agent-a' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.claim, { tabId: 'tab-1', tier: 'read-only', by: 'agent-a', since: 1000 });
  assert.deepEqual(TIERS, ['read-only', 'control']);
});

test('a claim without an author is refused: nobody may drive the window anonymously', () => {
  const claims = createClaimState();
  assert.equal(claims.claim('tab-1', {}).ok, false);
  assert.equal(claims.claim('tab-1', { by: '   ' }).ok, false);
  assert.equal(claims.claim('', { by: 'agent-a' }).ok, false);
});

test('an unknown tier is refused rather than silently downgraded', () => {
  const claims = createClaimState();
  assert.equal(claims.claim('tab-1', { by: 'a', tier: 'write-everything' }).ok, false);
});

test('one tab has one driver; a second agent is refused while the first holds it', () => {
  const claims = createClaimState();
  assert.equal(claims.claim('tab-1', { by: 'agent-a' }).ok, true);
  const second = claims.claim('tab-1', { by: 'agent-b' });
  assert.equal(second.ok, false);
  assert.match(second.reason, /agent-a/);
});

test('re-claiming keeps the claim and its clock, so a heartbeat does not flicker the badge', () => {
  let clock = 100;
  const claims = createClaimState({ now: () => clock });
  claims.claim('tab-1', { by: 'agent-a' });
  clock = 900;
  const again = claims.claim('tab-1', { by: 'agent-a', tier: 'control' });
  assert.equal(again.claim.since, 100);
  assert.equal(again.claim.tier, 'control');
  assert.equal(claims.list().length, 1);
});

test('only the holder can release, and releasing twice is harmless', () => {
  const claims = createClaimState();
  claims.claim('tab-1', { by: 'agent-a' });
  assert.equal(claims.release('tab-1', { by: 'agent-b' }).ok, false);
  assert.equal(claims.release('tab-1', { by: 'agent-a' }).released, true);
  assert.equal(claims.release('tab-1', { by: 'agent-a' }).released, false);
});

test('a client that disconnects takes all of its claims with it', () => {
  const claims = createClaimState();
  claims.claim('tab-1', { by: 'agent-a' });
  claims.claim('tab-2', { by: 'agent-a' });
  claims.claim('tab-3', { by: 'agent-b' });
  assert.equal(claims.releaseAll('agent-a'), 2);
  assert.deepEqual(claims.list().map((claim) => claim.tabId), ['tab-3']);
});

test('a closed tab cannot keep its badge alive', () => {
  const claims = createClaimState();
  claims.claim('tab-1', { by: 'agent-a' });
  claims.claim('tab-2', { by: 'agent-a' });
  assert.equal(claims.prune(['tab-1']), 1);
  assert.deepEqual(claims.list().map((claim) => claim.tabId), ['tab-1']);
});

test('the bridge refuses a caller without the token and answers state with it', async () => {
  const claims = createClaimState();
  const bridge = await startAgentBridge({ claims, tabs: () => [TAB('home'), TAB('svc:1')], token: 'secret' });
  try {
    const denied = await fetch(`${bridge.url}/state`);
    assert.equal(denied.status, 401);

    const state = await fetch(`${bridge.url}/state`, { headers: { authorization: 'Bearer secret' } });
    const body = await state.json();
    assert.equal(body.tabs.length, 2);
    assert.equal(body.tabs[1].agent, null);

    const claim = await fetch(`${bridge.url}/claim`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: JSON.stringify({ tabId: 'svc:1', by: 'agent-a' }),
    });
    assert.equal(claim.status, 200);

    const after = await (await fetch(`${bridge.url}/state`, { headers: { authorization: 'Bearer secret' } })).json();
    assert.equal(after.tabs[1].agent.tier, 'read-only');

    const unknown = await fetch(`${bridge.url}/claim`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: JSON.stringify({ tabId: 'nope', by: 'agent-a' }),
    });
    assert.equal(unknown.status, 404);

    const release = await fetch(`${bridge.url}/release`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: JSON.stringify({ tabId: 'svc:1', by: 'agent-a' }),
    });
    assert.equal((await release.json()).released, true);
  } finally {
    await bridge.close();
  }
});

test('the bridge tells the shell when a claim changes, so the badge is not polled', async () => {
  const claims = createClaimState();
  let changes = 0;
  const bridge = await startAgentBridge({
    claims,
    tabs: () => [TAB('svc:1')],
    token: 'secret',
    onChange: () => {
      changes += 1;
    },
  });
  try {
    const call = (path, body) =>
      fetch(`${bridge.url}${path}`, { method: 'POST', headers: { authorization: 'Bearer secret' }, body: JSON.stringify(body) });
    await call('/claim', { tabId: 'svc:1', by: 'agent-a' });
    await call('/release', { tabId: 'svc:1', by: 'agent-a' });
    await call('/release-all', { by: 'agent-a' });
    assert.equal(changes, 3);
  } finally {
    await bridge.close();
  }
});
