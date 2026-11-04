import test from 'node:test';
import assert from 'node:assert/strict';

import { LINK_ROUTE, classifyLink, hostOfAddress } from '../src/link-routing.mjs';

test('a web address opens as a tab, on either network', () => {
  // The window's proxy decides which network answers each request (see proxy-pac), so the
  // address is not a reason to keep a page out of the window.
  for (const url of [
    'http://dsh.peer-a.netbird/chat',
    'https://accounts.feishu.cn/open-apis/authen/v1/index?app_id=x',
    'https://datasage.flow.chat/r/daily-diagnosis',
    'http://127.0.0.1:3080/',
    'http://100.64.0.11/',
    'http://example.com/',
  ]) {
    const decision = classifyLink(url);
    assert.equal(decision.route, LINK_ROUTE.tab, url);
    assert.equal(decision.reason, 'web');
    assert.equal(decision.url, new URL(url).href, 'the address is normalized, not rewritten');
  }
});

test('a scheme another application owns is handed to the platform', () => {
  for (const url of ['mailto:someone@example.com', 'tel:+8610000000', 'sms:+8610000000']) {
    assert.equal(classifyLink(url).route, LINK_ROUTE.external, url);
  }
});

test('an address with nothing to open is ignored', () => {
  for (const url of ['', '   ', 'javascript:alert(1)', 'about:blank', 'data:text/html,hi', 'not a url']) {
    assert.equal(classifyLink(url).route, LINK_ROUTE.ignore, JSON.stringify(url));
  }
});

test('the decision says why, so a link that went the unexpected way can be explained', () => {
  assert.equal(classifyLink('https://example.com/').reason, 'web');
  assert.equal(classifyLink('mailto:a@b.c').reason, 'scheme:mailto');
  assert.equal(classifyLink('javascript:void(0)').reason, 'scheme:javascript');
  assert.equal(classifyLink('').reason, 'empty');
  assert.equal(classifyLink('nonsense').reason, 'unparsable');
});

test('hostOfAddress reads the host out of what a person or a config supplies', () => {
  assert.equal(hostOfAddress('http://dsh.b.netbird:3080/x'), 'dsh.b.netbird');
  assert.equal(hostOfAddress('dsh.b.netbird'), '');
  assert.equal(hostOfAddress('http://[::1]:8080/'), '::1');
  assert.equal(hostOfAddress('HTTP://DSH.B.NETBIRD/'), 'dsh.b.netbird');
  assert.equal(hostOfAddress(''), '');
});