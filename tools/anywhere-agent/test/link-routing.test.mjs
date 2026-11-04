import test from 'node:test';
import assert from 'node:assert/strict';

import { LINK_ROUTE, classifyLink, hostOfAddress } from '../src/link-routing.mjs';

/** The deployment this window was told about: the fleet's zones plus two published hosts. */
const published = {
  zones: ['netbird', 'netbird.cloud'],
  hosts: ['dsh.peer-a.netbird', 'dsh.peer-a.netbird:3080', 'http://superset.flowgpt/dashboard'],
};

function route(url, context = published) {
  return classifyLink(url, context).route;
}

test('this machine is always a tab: loopback needs no overlay', () => {
  for (const url of ['http://127.0.0.1:3080/chat', 'http://localhost:3000/', 'http://[::1]:8080/x', 'http://127.9.9.9/']) {
    assert.equal(route(url), LINK_ROUTE.tab, url);
  }
});

test('overlay addresses are tabs', () => {
  for (const url of [
    'http://100.64.0.11/chat',
    'http://100.127.255.254/',
    'http://10.1.2.3/',
    'http://172.16.4.5/',
    'http://172.31.255.1/',
    'http://192.168.1.5/',
    'http://169.254.10.1/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
  ]) {
    assert.equal(route(url), LINK_ROUTE.tab, url);
  }
});

test('addresses just outside the overlay ranges are public', () => {
  for (const url of [
    'http://100.63.255.255/',
    'http://100.128.0.1/',
    'http://172.15.0.1/',
    'http://172.32.0.1/',
    'http://8.8.8.8/',
  ]) {
    assert.equal(route(url), LINK_ROUTE.external, url);
  }
});

test('the fleet own names are tabs: single labels and the declared zones', () => {
  for (const url of [
    'http://tx/',
    'http://superset/dashboard',
    'http://dsh.peer-b.netbird/report',
    'https://peer-a.netbird.cloud/',
    'http://DSH.PEER-B.NETBIRD/uppercase-is-the-same-name',
    'http://dsh.peer-b.netbird./trailing-dot',
  ]) {
    assert.equal(route(url), LINK_ROUTE.tab, url);
  }
});

test('a host the deployment published is a tab even outside the zones', () => {
  assert.equal(route('http://superset.flowgpt/dashboard'), LINK_ROUTE.tab);
  assert.equal(route('http://dsh.peer-a.netbird:3080/chat'), LINK_ROUTE.tab, 'a published host with its port');
  assert.equal(route('http://superset.flowgpt:9999/other'), LINK_ROUTE.tab, 'the published name, another port');
});

test('public addresses leave for the platform browser', () => {
  for (const url of [
    'https://github.com/deepseek-ai/deepseek-harness',
    'https://datasage.flow.chat/r/daily-diagnosis',
    'http://example.com/',
    'http://news.invalid/x',
    'http://dsh.peer-a.netbird.example.com/',
    'http://notnetbird.com/',
    'http://peer-a.netbird.cloud.example.com/',
  ]) {
    assert.equal(route(url), LINK_ROUTE.external, url);
  }
});

test('a scheme that exists to reach another application is handed over, not loaded', () => {
  assert.equal(route('mailto:someone@example.com'), LINK_ROUTE.external);
  assert.equal(route('tel:+8610000000'), LINK_ROUTE.external);
});

test('an address with nothing to open is ignored rather than handed anywhere', () => {
  for (const url of ['', '   ', 'javascript:alert(1)', 'about:blank', 'data:text/html,hi', 'not a url']) {
    assert.equal(route(url), LINK_ROUTE.ignore, JSON.stringify(url));
  }
});

test('the decision says why, so a misrouted link can be explained', () => {
  assert.equal(classifyLink('http://127.0.0.1/').reason, 'loopback');
  assert.equal(classifyLink('http://tx/').reason, 'overlay-name');
  assert.equal(classifyLink('http://dsh.b.netbird/', published).reason, 'fleet-zone');
  assert.equal(classifyLink('http://superset.flowgpt/', published).reason, 'published-service');
  assert.equal(classifyLink('http://100.64.1.10/').reason, 'overlay-address');
  assert.equal(classifyLink('https://example.com/').reason, 'public');
  assert.equal(classifyLink('javascript:void(0)').reason, 'scheme:javascript');
  assert.equal(classifyLink('').reason, 'empty');
});

test('a missing or junk deployment description still routes safely', () => {
  assert.equal(classifyLink('https://example.com/', undefined).route, LINK_ROUTE.external);
  assert.equal(classifyLink('https://example.com/', {}).route, LINK_ROUTE.external);
  assert.equal(classifyLink('http://localhost:3080/', { zones: [null, '', '  '], hosts: [null, 42] }).route, LINK_ROUTE.tab);
  assert.equal(classifyLink('http://dsh.b.netbird/', { zones: ['.netbird.'], hosts: [] }).route, LINK_ROUTE.tab, 'zones are trimmed of dots');
});

test('hostOfAddress reads the host out of what a person or a config supplies', () => {
  assert.equal(hostOfAddress('http://dsh.b.netbird:3080/x'), 'dsh.b.netbird');
  assert.equal(hostOfAddress('dsh.b.netbird'), '');
  assert.equal(hostOfAddress('http://[::1]:8080/'), '::1');
  assert.equal(hostOfAddress('HTTP://DSH.B.NETBIRD/'), 'dsh.b.netbird');
  assert.equal(hostOfAddress(''), '');
});