import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ICO_SIZES,
  parseArgs,
  pngToIco,
  renderNsisScript,
  stageWindowsApp,
} from '../scripts/package-windows.mjs';

/** A byte string that starts like a PNG; the container only inspects the magic. */
function fakePng(size, fill = 0x11) {
  const buffer = Buffer.alloc(32, fill);
  buffer.writeUInt32BE(0x89504e47, 0);
  buffer.writeUInt32BE(size, 28);
  return buffer;
}

function fakeRuntime(root) {
  const runtime = join(root, 'electron-runtime');
  mkdirSync(join(runtime, 'resources'), { recursive: true });
  mkdirSync(join(runtime, 'locales'), { recursive: true });
  writeFileSync(join(runtime, 'electron.exe'), 'stub');
  writeFileSync(join(runtime, 'resources', 'electron.asar'), 'stub');
  return runtime;
}

test('an ICO carries one directory entry per size and PNG data offsets', () => {
  const entries = [
    { size: 16, png: fakePng(16) },
    { size: 48, png: fakePng(48) },
    { size: 256, png: fakePng(256) },
  ];
  const ico = pngToIco(entries);

  assert.equal(ico.readUInt16LE(0), 0, 'reserved');
  assert.equal(ico.readUInt16LE(2), 1, 'type icon');
  assert.equal(ico.readUInt16LE(4), 3, 'image count');

  const firstOffset = 6 + 16 * 3;
  assert.equal(ico.readUInt8(6), 16, '16px width');
  assert.equal(ico.readUInt8(7), 16, '16px height');
  assert.equal(ico.readUInt16LE(10), 1, 'one colour plane');
  assert.equal(ico.readUInt16LE(12), 32, '32 bits per pixel');
  assert.equal(ico.readUInt32LE(14), 32, 'first image length');
  assert.equal(ico.readUInt32LE(18), firstOffset, 'first image offset');

  // 256 is written as 0: the field is one byte and 256 does not fit it.
  const third = 6 + 16 * 2;
  assert.equal(ico.readUInt8(third), 0, '256px width is encoded as 0');
  const thirdOffset = ico.readUInt32LE(third + 12);
  assert.equal(thirdOffset, firstOffset + 32 + 32, 'images are laid out back to back');
  assert.equal(ico.subarray(thirdOffset, thirdOffset + 4).readUInt32BE(0), 0x89504e47, 'PNG payload intact');
});

test('an ICO refuses data that is not a PNG', () => {
  assert.throws(() => pngToIco([{ size: 16, png: Buffer.from('not a png') }]), /not a PNG/);
  assert.throws(() => pngToIco([{ size: 512, png: fakePng(512) }]), /1\.\.256/);
  assert.throws(() => pngToIco([]), /at least one image/);
});

test('the staged app is laid out where the shell looks for it', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-win-'));
  try {
    const runtime = fakeRuntime(root);
    const helper = join(root, 'anywhere-tunnel.exe');
    writeFileSync(helper, 'engine');
    const outDir = join(root, 'build');

    const staged = stageWindowsApp({
      runtimeDir: runtime,
      helperPath: helper,
      outDir,
      version: '0.4.6',
      build: '71',
      endpoint: 'https://netbird.example.com:443',
    });

    assert.equal(staged.exe, join(outDir, 'Anywhere Work', 'Anywhere Work.exe'));
    assert.ok(existsSync(staged.exe), 'the runtime executable is renamed to the product');
    assert.ok(!existsSync(join(outDir, 'Anywhere Work', 'electron.exe')), 'and nothing is left under the vendor name');
    assert.ok(existsSync(join(staged.appDir, 'locales')), 'the rest of the runtime travels with it');
    assert.ok(existsSync(join(staged.appDir, 'resources', 'app', 'shell', 'main.mjs')), 'payload shell');
    assert.ok(existsSync(join(staged.appDir, 'resources', 'app', 'src', 'helper-path.mjs')), 'payload src');
    assert.ok(
      existsSync(join(staged.appDir, 'resources', 'app', 'packaging', 'version-contract.json')),
      'version contract',
    );
    assert.equal(staged.helper, join(outDir, 'Anywhere Work', 'resources', 'bin', 'anywhere-tunnel.exe'));
    assert.equal(readFileSync(staged.helper, 'utf8'), 'engine', 'the engine keeps its Windows name');

    const payload = JSON.parse(readFileSync(join(staged.appDir, 'resources', 'app', 'package.json'), 'utf8'));
    assert.equal(payload.version, '0.4.6');
    assert.equal(payload.build, '71');
    assert.equal(payload.main, 'shell/main.mjs');
    assert.equal(payload.productName, 'Anywhere Work');

    const endpoint = JSON.parse(readFileSync(join(staged.appDir, 'resources', 'app', 'endpoint.json'), 'utf8'));
    assert.equal(endpoint.managementUrl, 'https://netbird.example.com:443');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a build without an endpoint does not bake a placeholder one in', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-win-'));
  try {
    const helper = join(root, 'anywhere-tunnel.exe');
    writeFileSync(helper, 'engine');
    const staged = stageWindowsApp({
      runtimeDir: fakeRuntime(root),
      helperPath: helper,
      outDir: join(root, 'build'),
      version: '0.4.6',
      build: '71',
    });
    assert.ok(!existsSync(join(staged.appDir, 'resources', 'app', 'endpoint.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing inputs are named, not crashed over', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-win-'));
  try {
    assert.throws(
      () =>
        stageWindowsApp({
          runtimeDir: join(root, 'nope'),
          helperPath: join(root, 'nope.exe'),
          outDir: join(root, 'build'),
          version: '0.4.6',
          build: '1',
        }),
      /missing input: Electron runtime/,
    );
    const runtime = fakeRuntime(root);
    const helper = join(root, 'anywhere-tunnel.exe');
    writeFileSync(helper, 'engine');
    rmSync(join(runtime, 'electron.exe'));
    assert.throws(
      () =>
        stageWindowsApp({
          runtimeDir: runtime,
          helperPath: helper,
          outDir: join(root, 'build'),
          version: '0.4.6',
          build: '1',
        }),
      /no electron\.exe/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the installer is per-user and carries the build number Windows compares', () => {
  const nsi = renderNsisScript({
    appDir: 'C:\\build\\Anywhere Work',
    version: '0.4.6',
    build: 71,
    outFile: 'C:\\build\\Anywhere Work-0.4.6-71.exe',
    installNotes: 'press More info, then Run anyway',
    endpoint: 'https://netbird.example.com:443',
  });

  assert.match(nsi, /RequestExecutionLevel user/, 'no administrator prompt');
  assert.match(nsi, /InstallDir "\$LOCALAPPDATA\\Programs\\Anywhere Work"/);
  assert.match(nsi, /VIProductVersion "0\.4\.6\.71"/, 'the build number is the fourth component');
  assert.match(nsi, /VIAddVersionKey "ProductVersion" "0\.4\.6"/);
  assert.match(nsi, /DisplayVersion" "0\.4\.6 \(71\)"/, 'Apps & features shows version and build');
  // Quoted: the path has a space in it, so an unquoted value is a command line Windows
  // has to guess at - and the quiet form would look like the uninstaller taking an
  // argument it never received.
  assert.ok(nsi.includes(`"UninstallString" '"$INSTDIR\\Uninstall.exe"'`), 'the uninstall string is quoted');
  assert.ok(nsi.includes(`"QuietUninstallString" '"$INSTDIR\\Uninstall.exe" /S'`), 'and the silent one too');
  assert.match(nsi, /File \/r "C:\\build\\Anywhere Work\\\*\.\*"/);

  assert.match(nsi, /WriteRegStr HKCU "Software\\Anywhere Work" "ManagementUrl"/, 'the endpoint is recorded');
  assert.ok(nsi.includes('press More info, then Run anyway'), 'the install notes travel with the install');
});

test('notes are shipped as a file when there is one, and written in chunks otherwise', () => {
  const base = {
    appDir: 'C:\\build\\Anywhere Work',
    version: '0.4.6',
    build: 71,
    outFile: 'C:\\build\\Anywhere Work-0.4.6-71.exe',
  };

  const asFile = renderNsisScript({...base, notesPath: 'C:\\repo\\install-notes.txt'});
  assert.ok(asFile.includes('File "C:\\repo\\install-notes.txt"'), 'the notes travel as a file');
  assert.equal(asFile.includes('FileWrite'), false, 'and are not also written inline');

  // 46 lines of bilingual notes in one FileWrite exceed NSIS's parser limit, so the
  // text is chunked; an empty text must produce neither a write nor a crash.
  const chunked = renderNsisScript({...base, installNotes: 'line one\n'.repeat(80)});
  assert.ok(chunked.includes('FileOpen $0'), 'chunked writes are opened');
  assert.ok((chunked.match(/FileWrite/g) ?? []).length > 1, 'and split across writes');
  assert.ok(Math.max(...chunked.split('\n').map((line) => line.length)) < 1024, 'no line exceeds the parser limit');

  const empty = renderNsisScript({...base, installNotes: ''});
  assert.equal(empty.includes('FileWrite'), false);
  assert.equal(empty.includes('install-notes.txt'), false);
});

test('the build-time file path is spelled by the host that runs makensis', () => {
  const base = {
    appDir: 'C:\\build\\Anywhere Work',
    version: '0.4.6',
    build: 71,
    outFile: 'C:\\build\\Anywhere Work-0.4.6-71.exe',
  };
  // Default: the Windows spelling, which is what the release job on windows-2025 needs.
  assert.ok(renderNsisScript(base).includes('File /r "C:\\build\\Anywhere Work\\*.*"'));
  // A Linux host building the same installer passes its own separator, because makensis
  // resolves File paths itself; the runtime paths stay Windows strings either way.
  const posix = renderNsisScript({...base, fileGlob: '/home/pc/build/Anywhere Work/*.*'});
  assert.ok(posix.includes('File /r "/home/pc/build/Anywhere Work/*.*"'));
  assert.ok(posix.includes('$INSTDIR\\Anywhere Work.exe'), 'runtime paths are untouched');
});


test('an installer can carry a pre-rendered icon', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-win-'));
  try {
    const helper = join(root, 'anywhere-tunnel.exe');
    writeFileSync(helper, 'engine');
    const ico = join(root, 'app-icon.ico');
    writeFileSync(ico, pngToIco([{ size: 16, png: fakePng(16) }]));

    const staged = stageWindowsApp({
      runtimeDir: fakeRuntime(root),
      helperPath: helper,
      outDir: join(root, 'build'),
      version: '0.4.6',
      build: '71',
      iconPath: ico,
    });
    // A host that cannot run the target runtime still produces an installer with the
    // product's icon by handing the finished file in.
    assert.ok(existsSync(staged.icon), 'the icon lands in the app');
    assert.equal(readFileSync(staged.icon).length, readFileSync(ico).length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the installer names that icon when there is one, and stays quiet when there is not', () => {
  // Windows paths through a regex would need four levels of escaping; the file is
  // compared as text instead, which is what the generated script is.
  const icon = 'C:\\build\\Anywhere Work\\resources\\app-icon.ico';
  const base = {
    appDir: 'C:\\build\\Anywhere Work',
    version: '0.4.6',
    build: 71,
    outFile: 'C:\\build\\Anywhere Work-0.4.6-71.exe',
  };

  const withIcon = renderNsisScript({...base, iconPath: icon});
  assert.ok(withIcon.includes(`!define MUI_ICON "${icon}"`), 'the installer names the icon');
  assert.ok(withIcon.includes(`!define MUI_UNICON "${icon}"`), 'and so does its uninstaller');

  const withoutIcon = renderNsisScript(base);
  assert.equal(withoutIcon.includes('MUI_ICON'), false, 'no icon define when there is no icon');
});

test('the icon size list matches what Windows asks for', () => {
  assert.deepEqual(ICO_SIZES, [16, 24, 32, 48, 64, 128, 256]);
});

test('arguments are explicit', () => {
  assert.deepEqual(parseArgs(['--runtime', '/r', '--helper', '/h.exe', '--no-icon']), {
    runtime: '/r',
    helper: '/h.exe',
    icon: false,
  });
  assert.deepEqual(parseArgs(['--out-dir', '/o']), { outDir: '/o' });
  assert.deepEqual(parseArgs(['--runtime', '/r', '--helper', '/h.exe', '--icon', '/x/app.ico']), {
    runtime: '/r',
    helper: '/h.exe',
    icon: '/x/app.ico',
  });
  assert.throws(() => parseArgs(['--runtime']), /needs a value/);
  assert.throws(() => parseArgs(['stray']), /unexpected argument/);
});