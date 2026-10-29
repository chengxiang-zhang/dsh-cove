/**
 * One version, and a build number that moves.
 *
 * The desktop installer is attached to the same tagged release as the runtime package, so
 * "the version" is one number that names both. It used to be typed into the version
 * contract as well, where it stayed at the value someone wrote on the first day - a
 * rebuilt app reported the same version, and nothing in the pipeline could tell that the
 * app a person installed was not the app they had just built.
 *
 * These assertions are the desktop half of the gate; the cross-client doctrine (both
 * clients, both workflows, the APK channel) belongs to `scripts/version-doctrine.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, '..');
const REPO = join(TOOL, '..', '..');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('the app version is the repository version, not a second copy', () => {
  const app = readJson(join(TOOL, 'package.json'));
  const runtime = readJson(join(REPO, 'packages', 'dsh-web-all', 'package.json'));
  assert.equal(
    app.version,
    runtime.version,
    'a tag carries the runtime package and this installer together, so one version names both',
  );
});

test('the contract carries compatibility facts, not a product version', () => {
  const contract = readJson(join(TOOL, 'packaging', 'version-contract.json'));
  assert.equal('shell' in contract, false, 'the product version has one owner; a second copy goes stale');
  // The fields the runtime really reads: `checkContract` in src/update.mjs compares the
  // engine's protocol and its netbird version against these.
  assert.equal(typeof contract.protocol, 'number');
  assert.equal(typeof contract.netbird, 'string');
  assert.equal(typeof contract.helper, 'string');
  assert.equal(typeof contract.update, 'object');
});

test('the dev entry manifest carries no version of its own', () => {
  // `shell/package.json` is the entry `electron shell` needs, and it ships inside the
  // bundle beside the payload manifest the packager writes. It used to carry `0.1.0` from
  // the first day - a second number that never moved and could only ever be wrong, which
  // is the same shape the contract's `shell` field had.
  const entry = readJson(join(TOOL, 'shell', 'package.json'));
  assert.equal('version' in entry, false, 'the version has one owner: the repository release');
  assert.equal(entry.main, 'main.mjs', 'the entry still names its main file');
  assert.equal(entry.private, true, 'and is never published');
});

test('packaging takes the version from the repository and a build number from git', () => {
  const script = readFileSync(join(TOOL, 'scripts', 'package-mac.sh'), 'utf8');
  assert.match(script, /packages\/dsh-web-all\/package\.json/, 'the version comes from the released runtime package');
  assert.doesNotMatch(script, /\['shell'\]/, 'the contract is not a version source any more');
  assert.match(script, /rev-list --count HEAD/, 'a bundle needs a build number that moves with the tree');
  assert.match(script, /CFBundleVersion "\$BUILD"/, 'macOS compares the build number, not the marketing version');
  assert.match(script, /APP_NAME-\$VERSION-\$BUILD_LABEL\.dmg/, 'the installer is named by version and build');
});