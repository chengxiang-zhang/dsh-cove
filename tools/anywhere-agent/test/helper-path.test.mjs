import { test } from 'node:test';
import assert from 'node:assert/strict';

import { helperBinaryName, helperCandidates, resolveHelper } from '../src/helper-path.mjs';

test('the engine binary is named per platform', () => {
  assert.equal(helperBinaryName('win32'), 'anywhere-tunnel.exe');
  assert.equal(helperBinaryName('darwin'), 'anywhere-tunnel');
  assert.equal(helperBinaryName('linux'), 'anywhere-tunnel');
});

test('the packaged copy outranks the developer cache', () => {
  const candidates = helperCandidates({
    platform: 'darwin',
    override: '/opt/engine/anywhere-tunnel',
    resourcesPath: '/Applications/Anywhere Work.app/Contents/Resources',
    home: '/Users/someone',
  });
  assert.deepEqual(candidates, [
    '/opt/engine/anywhere-tunnel',
    '/Applications/Anywhere Work.app/Contents/Resources/bin/anywhere-tunnel',
    '/Users/someone/.cache/anywhere-agent/bin/anywhere-tunnel',
  ]);
});

test('Windows looks for the .exe, including its own local cache', () => {
  const candidates = helperCandidates({
    platform: 'win32',
    resourcesPath: 'C:\\Program Files\\Anywhere Work\\resources',
    home: 'C:\\Users\\someone',
  });
  assert.deepEqual(candidates, [
    'C:\\Program Files\\Anywhere Work\\resources\\bin\\anywhere-tunnel.exe',
    'C:\\Users\\someone\\.cache\\anywhere-agent\\bin\\anywhere-tunnel.exe',
    'C:\\Users\\someone\\AppData\\Local\\anywhere-agent\\bin\\anywhere-tunnel.exe',
  ]);
  assert.ok(candidates.every((candidate) => candidate.endsWith('.exe')));
});

test('an empty override does not become a candidate', () => {
  const candidates = helperCandidates({ platform: 'darwin', override: '', resourcesPath: '', home: '/home/x' });
  assert.deepEqual(candidates, ['/home/x/.cache/anywhere-agent/bin/anywhere-tunnel']);
});

test('resolution reports the binary it found', () => {
  const shipped = '/Applications/Anywhere Work.app/Contents/Resources/bin/anywhere-tunnel';
  const resolution = resolveHelper({
    platform: 'darwin',
    resourcesPath: '/Applications/Anywhere Work.app/Contents/Resources',
    home: '/Users/someone',
    exists: (candidate) => candidate === shipped,
  });
  assert.equal(resolution.found, true);
  assert.equal(resolution.path, shipped);
});

test('a miss is a miss, not a first candidate that happens to be off disk', () => {
  const resolution = resolveHelper({
    platform: 'win32',
    resourcesPath: 'C:\\Program Files\\Anywhere Work\\resources',
    home: 'C:\\Users\\someone',
    exists: () => false,
  });
  assert.equal(resolution.found, false);
  assert.equal(resolution.path, 'C:\\Program Files\\Anywhere Work\\resources\\bin\\anywhere-tunnel.exe');
  assert.equal(resolution.candidates.length, 3);
});

test('resolution without a filesystem check is refused', () => {
  assert.throws(() => resolveHelper({ platform: 'darwin', home: '/home/x' }), TypeError);
});