import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClaimState, startAgentBridge } from '../src/agent-bridge.mjs';
import { bridgeCall, readBridgeFile, readCdpEndpoint, runBridgeCli, tabLines } from '../bin/anywhere-agent-bridge.mjs';

const TAB = (id, title = id) => ({ id, title, serviceId: `machine:${id}`, active: false });

function stateDir(bridge) {
  const dir = mkdtempSync(join(tmpdir(), 'aw-bridge-'));
  writeFileSync(join(dir, 'agent-bridge.json'), JSON.stringify(bridge));
  return dir;
}

test('a missing endpoint file is "no window", not a crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-bridge-none-'));
  const result = await runBridgeCli(['state', '--dir', dir]);
  assert.equal(result.exitCode, 2);
  assert.match(result.out, /no window to talk to/);
  assert.equal(readBridgeFile(dir), null);
});

test('the CLI lists the window\'s tabs, marking the active one and any driver', async () => {
  const claims = createClaimState();
  const bridge = await startAgentBridge({ claims, tabs: () => [{ ...TAB('home', '首页'), active: true }, TAB('svc:1', '财报面板')], token: 'tok' });
  try {
    claims.claim('svc:1', { by: 'poc-agent', tier: 'control' });
    const dir = stateDir({ url: bridge.url, token: 'tok' });
    const listed = await runBridgeCli(['state', '--dir', dir]);
    assert.equal(listed.exitCode, 0);
    assert.match(listed.out, /^\* home\t首页$/m);
    assert.match(listed.out, /^ {2}svc:1\t财报面板 \[control by poc-agent\]$/m);

    const ids = await runBridgeCli(['tabs', '--dir', dir]);
    assert.deepEqual(ids.out.trim().split('\n'), ['home', 'svc:1']);
  } finally {
    await bridge.close();
  }
});

test('claim and release go through the CLI and the window agrees', async () => {
  const claims = createClaimState();
  const bridge = await startAgentBridge({ claims, tabs: () => [TAB('svc:1')], token: 'tok' });
  try {
    const dir = stateDir({ url: bridge.url, token: 'tok' });
    const claimed = await runBridgeCli(['claim', 'svc:1', '--by', 'poc-agent', '--tier', 'read-only', '--dir', dir]);
    assert.equal(claimed.exitCode, 0);
    assert.equal(JSON.parse(claimed.out).claim.tier, 'read-only');
    assert.equal(claims.get('svc:1').by, 'poc-agent');

    const released = await runBridgeCli(['release', 'svc:1', '--by', 'poc-agent', '--dir', dir]);
    assert.equal(released.exitCode, 0);
    assert.equal(claims.get('svc:1'), null);
  } finally {
    await bridge.close();
  }
});

test('the window refuses a second driver, and the CLI reports the refusal as a failure', async () => {
  const claims = createClaimState();
  const bridge = await startAgentBridge({ claims, tabs: () => [TAB('svc:1')], token: 'tok' });
  try {
    const dir = stateDir({ url: bridge.url, token: 'tok' });
    await runBridgeCli(['claim', 'svc:1', '--by', 'first', '--dir', dir]);
    const second = await runBridgeCli(['claim', 'svc:1', '--by', 'second', '--dir', dir]);
    assert.equal(second.exitCode, 1);
    assert.match(second.out, /first is already driving this tab/);
  } finally {
    await bridge.close();
  }
});

test('a wrong token is a failure, not an empty list', async () => {
  const bridge = await startAgentBridge({ claims: createClaimState(), tabs: () => [TAB('home')], token: 'tok' });
  try {
    const result = await bridgeCall({ url: bridge.url, token: 'wrong' }, '/state');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  } finally {
    await bridge.close();
  }
});

test('the CDP endpoint comes from the file Chromium writes, and is absent when it was not asked for', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-cdp-'));
  mkdirSync(join(dir, 'chromium'), { recursive: true });
  assert.equal(readCdpEndpoint(dir), '');
  writeFileSync(join(dir, 'chromium', 'DevToolsActivePort'), '51234\n/devtools/browser/abc\n');
  assert.equal(readCdpEndpoint(dir), 'http://127.0.0.1:51234');
});

test('unknown commands are refused instead of quietly doing nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-bridge-unknown-'));
  writeFileSync(join(dir, 'agent-bridge.json'), JSON.stringify({ url: 'http://127.0.0.1:1', token: 'x' }));
  const result = await runBridgeCli(['frobnicate', '--dir', dir]);
  assert.equal(result.exitCode, 1);
  assert.match(result.out, /unknown command/);
});

test('tab lines stay readable when a tab has no title yet', () => {
  assert.deepEqual(tabLines({ tabs: [{ id: 'svc:1', title: '', active: false, agent: null }] }), ['  svc:1\t']);
});
