import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { pacDataUrl, pacScript, proxyEntryOf } from '../src/proxy-pac.mjs';

/**
 * A minimal PAC runtime, faithful to the helpers the generated script uses.
 *
 * Chromium evaluates the script with these globals; running the same source here is what
 * makes "public goes direct, the overlay goes through the agent" a checked property rather
 * than a claim about a string.
 */
function pacRuntime(source) {
  const context = {
    isPlainHostName: (host) => !String(host).includes('.'),
    shExpMatch: (value, pattern) => {
      const escaped = String(pattern)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      return new RegExp(`^${escaped}$`, 'i').test(String(value));
    },
    dnsDomainIs: (host, domain) => String(host).endsWith(String(domain)),
    isInNet: () => false,
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.__findProxy = FindProxyForURL;`, context);
  return (url, host) => context.__findProxy(url, host);
}

const PROXY = 'PROXY 127.0.0.1:19001';
const DIRECT = 'DIRECT';
const script = pacScript({
  upstream: 'http://127.0.0.1:19001',
  zones: ['netbird', 'netbird.cloud'],
  hosts: ['dsh.peer-a.netbird', 'superset.flowgpt', 'DSH.Peer-A.Netbird:3080'],
});
const findProxy = pacRuntime(script);
const route = (url) => findProxy(url, new URL(url).hostname);

test('the overlay goes through the agent', () => {
  for (const url of [
    'http://dsh.peer-a.netbird/chat',
    'https://peer-a.netbird.cloud/',
    'http://superset.flowgpt/dashboard',
    'http://tx/',
    'http://100.64.0.11/',
    'http://100.127.255.254/',
  ]) {
    assert.equal(route(url), PROXY, url);
  }
});

test('the public network goes direct', () => {
  for (const url of [
    'https://accounts.feishu.cn/open-apis/authen/v1/index?app_id=x',
    'https://sso-data.flow.chat/callback',
    'https://datasage.flow.chat/r/daily-diagnosis',
    'https://github.com/deepseek-ai/deepseek-harness',
    'http://example.com/',
    'http://100.128.0.1/',
    'http://192.168.1.5/',
    'https://dsh.peer-a.netbird.example.com/',
  ]) {
    assert.equal(route(url), DIRECT, url);
  }
});

test('this machine is direct, so its workspace opens with the fleet down', () => {
  for (const url of ['http://127.0.0.1:3080/', 'http://localhost:3000/', 'http://127.9.9.9/']) {
    assert.equal(route(url), DIRECT, url);
  }
});

test('a zone match is a suffix match, not a substring', () => {
  assert.equal(route('http://notnetbird.com/'), DIRECT);
  assert.equal(route('http://netbird.example.com/'), DIRECT);
  assert.equal(route('http://a.b.netbird/'), PROXY);
});

test('a published host is matched by name, ignoring case and port', () => {
  assert.equal(route('http://dsh.peer-a.netbird/chat'), PROXY);
  assert.equal(route('https://superset.flowgpt:8443/x'), PROXY);
  assert.equal(route('http://superset.flowgpt.evil.com/'), DIRECT);
});

test('no usable proxy means no script, and an empty script is no data URL', () => {
  assert.equal(pacScript({ upstream: '' }), '');
  assert.equal(pacScript({ upstream: 'not a url' }), '');
  assert.equal(pacScript({ upstream: 'ftp://127.0.0.1:1' }), '');
  assert.equal(pacDataUrl(''), '');
});

test('proxyEntryOf turns the agent address into a PAC entry', () => {
  assert.equal(proxyEntryOf('http://127.0.0.1:19001'), 'PROXY 127.0.0.1:19001');
  assert.equal(proxyEntryOf('http://127.0.0.1'), 'PROXY 127.0.0.1:80');
  assert.equal(proxyEntryOf('https://agent.test'), 'PROXY agent.test:443');
  assert.equal(proxyEntryOf(''), '');
  assert.equal(proxyEntryOf('garbage'), '');
});

test('the data URL carries the script', () => {
  const url = pacDataUrl(script);
  assert.ok(url.startsWith('data:application/x-javascript;base64,'));
  const decoded = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString('utf8');
  assert.equal(decoded, script);
});