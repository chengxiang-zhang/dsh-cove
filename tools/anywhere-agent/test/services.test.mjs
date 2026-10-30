import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeServices, parseServices } from '../src/services.mjs';

test('a catalogue entry keeps its id, name and address', () => {
  const services = normalizeServices({ services: [{ id: 'web:superset', name: 'Superset', subtitle: '大盘', url: 'http://superset.netbird/' }] });
  assert.equal(services.length, 1);
  assert.deepEqual(services[0], {
    id: 'web:superset',
    kind: 'web',
    name: 'Superset',
    subtitle: '大盘',
    url: 'http://superset.netbird/',
    host: 'superset.netbird',
  });
});

test('an entry without an http(s) address is refused instead of half-loading', () => {
  const services = normalizeServices([
    { name: 'bad', url: 'file:///etc/passwd' },
    { name: 'also-bad', url: 'javascript:alert(1)' },
    { name: 'good', url: 'https://git.netbird/' },
  ]);
  assert.deepEqual(services.map((service) => service.name), ['good']);
});

test('an entry without a name is refused, and ids fall back to the name', () => {
  const services = normalizeServices([{ url: 'http://a.netbird/' }, { name: 'Data Sage', url: 'http://b.netbird/' }]);
  assert.equal(services.length, 1);
  assert.match(services[0].id, /^web:data-sage/);
  assert.equal(services[0].host, 'b.netbird');
});

test('unknown fields are ignored, so a newer document still works', () => {
  const services = normalizeServices([{ id: 'x', name: 'X', url: 'http://x.netbird/', icon: 'zap', future: { a: 1 } }]);
  assert.equal(services.length, 1);
  assert.equal('future' in services[0], false);
});

test('duplicate ids collapse and broken entries do not remove their neighbours', () => {
  const services = normalizeServices([
    { id: 'web:dup', name: 'A', url: 'http://a.netbird/' },
    { id: 'web:dup', name: 'B', url: 'http://b.netbird/' },
    null,
    42,
    { id: 'web:c', name: 'C', url: 'http://c.netbird/' },
  ]);
  assert.deepEqual(services.map((service) => service.name), ['A', 'C']);
});

test('a malformed document is an empty catalogue, not a throw', () => {
  assert.deepEqual(parseServices('{not json'), []);
  assert.deepEqual(parseServices(''), []);
  assert.deepEqual(parseServices('null'), []);
  assert.equal(parseServices('{"services":[{"name":"A","url":"http://a/"}]}').length, 1);
});
