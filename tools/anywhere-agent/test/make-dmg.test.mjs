/**
 * Tests for scripts/make-dmg.sh.
 *
 * The disk image is an installer, not a folder with an app in it, and the two things that
 * make it one - the Applications shortcut and the install notes - are asserted by mounting
 * the file the script wrote, not by reading the script that wrote it. A stub bundle stands
 * in for the real app: the layout has nothing to do with Electron, and testing it should
 * not need a 300MB runtime.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/make-dmg.sh', import.meta.url));
const NOTES = fileURLToPath(new URL('../packaging/install-notes.txt', import.meta.url));
// hdiutil, osascript and the DMG layout are macOS only; the artefact this builds is too.
const MACOS_ONLY = process.platform === 'darwin' ? false : 'the installer is a macOS artefact';
/** A real 1x1 PNG, so the background this test ships is a file the Finder could draw. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/** A minimal but real bundle: the Info.plist names the executable the check looks for. */
function makeStubApp(root) {
  const app = join(root, 'Stub.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Stub</string>
<key>CFBundleIdentifier</key><string>com.example.stub</string>
</dict></plist>
`);
  writeFileSync(join(app, 'Contents/MacOS/Stub'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return app;
}

function build(work, { app, out, extra = [] }) {
  return execFileSync('bash', [
    SCRIPT,
    '--app', app,
    '--out', out,
    '--volume', 'Stub Volume',
    // The Finder arrangement is best effort by design and cannot be scripted from every
    // session; the layout this test asserts must hold without it.
    '--no-layout',
    ...extra,
  ], { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Mount what was written and hand the mount point to the caller, unmounting afterwards. */
function withMountedImage(dmg, body) {
  const mount = mkdtempSync(join(tmpdir(), 'aw-mount-'));
  execFileSync('hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-noverify', '-noautoopen', '-mountpoint', mount], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    return body(mount);
  } finally {
    try {
      execFileSync('hdiutil', ['detach', mount, '-quiet'], { stdio: 'ignore' });
    } catch {
      // The assertion that matters has already run; a stuck mount must not hide it.
    }
    rmSync(mount, { recursive: true, force: true });
  }
}

test('the disk image installs the app: shortcut, notes and background travel with it', { skip: MACOS_ONLY }, () => {
  const work = mkdtempSync(join(tmpdir(), 'aw-dmg-'));
  try {
    const app = makeStubApp(work);
    const background = join(work, 'background.png');
    writeFileSync(background, PNG);
    const dmg = join(work, 'Stub-1.0.dmg');

    const output = build(work, { app, out: dmg, extra: ['--background', background, '--notes', NOTES] });
    assert.ok(existsSync(dmg), 'the image was written');
    assert.match(output, /layout verifies \(app, Applications shortcut, install notes\)/);

    withMountedImage(dmg, (mount) => {
      // The app itself, with the executable its own Info.plist names.
      assert.ok(existsSync(join(mount, 'Stub.app/Contents/MacOS/Stub')), 'the app is in the volume');

      // The shortcut: dragging onto it is what installs the app.
      const shortcut = join(mount, 'Applications');
      assert.ok(existsSync(shortcut), 'the Applications shortcut is in the volume');
      assert.equal(readlinkSync(shortcut), '/Applications', 'the shortcut points at /Applications');

      // The notes: readable without mounting anything else, in both languages.
      const notes = readFileSync(join(mount, '安装说明 How to install.txt'), 'utf8');
      assert.match(notes, /拖到.*应用程序/, 'the Chinese steps are there');
      assert.match(notes, /Drag .*Applications/, 'the English steps are there');
      // The Gatekeeper reality of an ad-hoc build, with the one way out that works on
      // every macOS version - not just "right-click, Open", which current macOS dropped.
      assert.match(notes, /xattr -dr com.apple\.quarantine "\/Applications\/Anywhere Work\.app"/);
      assert.match(notes, /系统设置/);

      // The picture the Finder draws, and the volume carries nothing else.
      assert.deepEqual(
        readdirSync(join(mount, '.background')),
        ['background.png'],
        'the background travels as the Finder expects to find it',
      );
      assert.deepEqual(
        readdirSync(mount).sort(),
        ['Applications', 'Stub.app', '.background', '安装说明 How to install.txt'].sort(),
        'the volume holds the app, the shortcut, the notes and the background, nothing else',
      );
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('an app that is not a bundle is refused rather than shipped', { skip: MACOS_ONLY }, () => {
  const work = mkdtempSync(join(tmpdir(), 'aw-dmg-'));
  try {
    const notAnApp = join(work, 'not-an-app');
    mkdirSync(notAnApp, { recursive: true });
    const dmg = join(work, 'Stub-1.0.dmg');

    assert.throws(
      () => build(work, { app: notAnApp, out: dmg }),
      (error) => {
        assert.match(String(error.stderr), /not an application bundle/);
        return true;
      },
    );
    assert.ok(!existsSync(dmg), 'nothing was written');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('the shipped notes stay installable copy, not a placeholder', () => {
  const notes = readFileSync(NOTES, 'utf8');
  // Both halves exist; a half-translated installer is a regression, not a style choice.
  const [chinese, english] = notes.split(/\nHow to install\n/);
  assert.ok(chinese.trim().length > 0 && english.trim().length > 0, 'the notes are bilingual');
  assert.match(english, /xattr -dr com\.apple\.quarantine/);
  assert.match(chinese, /xattr -dr com\.apple\.quarantine/);
  // The dialog a current macOS shows has no Open button, so the instructions have to lead
  // with the route that exists there, and mark the right-click path as the old one.
  assert.match(notes, /系统设置/);
  assert.match(notes, /仍要打开/);
  assert.match(notes, /macOS 14 及更早/);
  assert.match(english, /System Settings/);
  assert.match(english, /Open Anyway/);
  assert.match(english, /macOS 14 and earlier/);
});