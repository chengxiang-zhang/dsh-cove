#!/usr/bin/env node
/**
 * Package Anywhere Work for Windows.
 *
 * The macOS packager copies `Electron.app` and rewrites its `Info.plist` with
 * PlistBuddy; Windows has no bundle and no plist, so this script does the same job
 * with the pieces Windows actually has: the extracted Electron runtime is copied
 * as a directory, the payload goes to `resources/app` (the same
 * `process.resourcesPath`-relative layout the shell already resolves), the engine
 * binary ships beside it as `anywhere-tunnel.exe`, the brand artwork becomes a
 * multi-size `.ico`, and the version metadata lives in the NSIS installer that
 * wraps the directory.
 *
 * It is written in Node and takes every input as an argument so the staging half
 * is exercised on any host: the workflow that runs it is Windows-only, but the
 * layout it produces must not be.
 *
 * Usage:
 *   node scripts/package-windows.mjs --runtime <dir> --helper <anywhere-tunnel.exe> \
 *     [--out tools/anywhere-agent/build] [--version 0.4.6] [--build 71] \
 *     [--endpoint https://netbird.example.com:443] [--no-icon]
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');

/** Icon sizes Windows asks for, from the taskbar to the extra-large view. */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const APP_NAME = 'Anywhere Work';
const APP_EXE = `${APP_NAME}.exe`;
const ENGINE_NAME = 'anywhere-tunnel.exe';

/**
 * Wraps PNG images in an ICO container.
 *
 * Windows has accepted PNG-compressed icons since Vista, so the artwork is
 * rasterised once per size and embedded as-is; the alternative is a BMP encoder
 * with an AND mask, which is more code for a worse result.
 *
 * @param {Array<{ size: number, png: Buffer }>} entries one entry per size, largest last is fine
 * @returns {Buffer}
 */
export function pngToIco(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('pngToIco needs at least one image');
  }
  for (const entry of entries) {
    if (!Number.isInteger(entry?.size) || entry.size < 1 || entry.size > 256) {
      throw new TypeError(`icon size must be 1..256, got ${entry?.size}`);
    }
    if (!Buffer.isBuffer(entry.png) || entry.png.length === 0) {
      throw new TypeError(`icon ${entry.size} has no PNG data`);
    }
    if (entry.png.readUInt32BE(0) !== 0x89504e47) {
      throw new TypeError(`icon ${entry.size} is not a PNG`);
    }
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach((entry, index) => {
    const at = index * 16;
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, at); // 0 means 256
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size, unused for PNG
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // color planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

/**
 * Rasterises the brand artwork through the distribution's own Electron runtime.
 *
 * Each size is rendered directly rather than scaled down from one 1024px capture:
 * Windows has no `sips`, and rendering at the target size is what keeps a 16px
 * taskbar icon legible. The runtime must be the distribution copy, not the staged
 * app: a staged directory carries `resources/app`, so `Electron <script>` would
 * launch the app instead of the renderer.
 *
 * @param {{ runtimeExe: string, script: string, svg: string, sizes?: number[], workDir: string }} options
 * @returns {Array<{ size: number, png: Buffer }>}
 */
export function renderIconPngs({ runtimeExe, script, svg, sizes = ICO_SIZES, workDir }) {
  mkdirSync(workDir, { recursive: true });
  return sizes.map((size) => {
    const out = join(workDir, `icon-${size}.png`);
    const result = spawnSync(runtimeExe, [script, svg, out, String(size)], { stdio: 'inherit' });
    if (result.error || result.status !== 0 || !existsSync(out)) {
      throw new Error(`could not rasterise the app icon at ${size}px (exit ${result.status ?? 'n/a'})`);
    }
    return { size, png: readFileSync(out) };
  });
}

/**
 * Renders the NSIS script that turns the staged directory into an installer.
 *
 * `iconPath` is the installer's own icon (the one Windows shows on the downloaded
 * file and in the install dialog). It is optional because the icon is rendered by the
 * target platform's runtime, so a build on another host may legitimately arrive
 * without one.
 *
 * Per-user, no elevation: the client changes neither the machine's gateway nor its
 * proxy, so it has no business asking for administrator rights. The version the
 * installer declares is what Windows shows in Apps & features and what an upgrade
 * compares, which is why `VIProductVersion` carries the build number as its fourth
 * component - the same number the macOS bundle puts in `CFBundleVersion`.
 *
 * @param {{
 *   appDir: string, productName: string, exeName: string, version: string, build: number,
 *   outFile: string, publisher: string, installNotes: string, endpoint: string,
 *   iconPath?: string, fileGlob?: string, notesPath?: string,
 * }} options `fileGlob` is the build-time path of the staged tree. It is spelled by the
 *   caller because the separator belongs to the host running makensis, not to Windows:
 *   NSIS on Linux needs `/*.*`, and the runtime paths elsewhere in this script are
 *   Windows strings either way.
 * @returns {string}
 */
export function renderNsisScript({
  appDir,
  productName = APP_NAME,
  exeName = APP_EXE,
  version,
  build,
  outFile,
  publisher = 'Anywhere Work',
  installNotes = '',
  endpoint = '',
  iconPath = '',
  fileGlob = '',
  notesPath = '',
}) {
  const [major = '0', minor = '0', patch = '0'] = String(version).split('.');
  const viVersion = `${Number(major)}.${Number(minor)}.${Number(patch)}.${Number(build)}`;
  const notes = installNotes.replace(/\r?\n/g, '\r\n');
  // The notes ship as a file when the build has one - the normal path - and are written
  // as chunks otherwise: NSIS parses one line at a time, and a bilingual notes file in a
  // single FileWrite is longer than its parser accepts (it reports an unterminated
  // string, which is what a truncated line looks like).
  const chunks = notes === '' ? [] : (notes.match(/[\s\S]{1,300}/g) ?? []);
  const notesFile = notesPath !== ''
    ? `  File "${notesPath}"`
    : chunks
        .map((chunk) => `  FileWrite $0 "${chunk.replace(/"/g, '$\\"').replace(/\r\n/g, '$\\r$\\n')}"`)
        .join('\r\n');
  const writeNotes = notesPath !== ''
    ? notesFile
    : chunks.length === 0
      ? ''
      : `  FileOpen $0 "$INSTDIR\\install-notes.txt" w\r\n${notesFile}\r\n  FileClose $0`;
  const endpointLine = endpoint
    ? `  WriteRegStr HKCU "Software\\${productName}" "ManagementUrl" "${endpoint}"\r\n`
    : '';

  return `; Generated by tools/anywhere-agent/scripts/package-windows.mjs - do not edit.
Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"
${iconPath ? `!define MUI_ICON "${iconPath}"\r\n!define MUI_UNICON "${iconPath}"\r\n` : ''}

Name "${productName}"
OutFile "${outFile}"
InstallDir "$LOCALAPPDATA\\Programs\\${productName}"
InstallDirRegKey HKCU "Software\\${productName}" "InstallDir"

VIProductVersion "${viVersion}"
VIAddVersionKey "ProductName" "${productName}"
VIAddVersionKey "CompanyName" "${publisher}"
VIAddVersionKey "FileDescription" "${productName} installer"
VIAddVersionKey "FileVersion" "${version} (${build})"
VIAddVersionKey "ProductVersion" "${version}"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${fileGlob || `${appDir}\\*.*`}"
  WriteRegStr HKCU "Software\\${productName}" "InstallDir" "$INSTDIR"
${endpointLine}  WriteUninstaller "$INSTDIR\\Uninstall.exe"

  ; Apps & features: the installer owns the version a person sees and an upgrade
  ; compares. DisplayVersion is the released version, DisplayIcon the app itself.
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${productName}" "DisplayName" "${productName}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${productName}" "DisplayVersion" "${version} (${build})"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${productName}" "Publisher" "${publisher}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${productName}" "DisplayIcon" "$INSTDIR\\${exeName}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${productName}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${productName}" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${productName}" "NoRepair" 1
  ; Quoted, because the install path contains a space: an unquoted UninstallString is a
  ; command line Windows has to guess at, and the quiet form below would be parsed as the
  ; uninstaller taking an argument it does not have. NSIS single quotes keep the inner
  ; double quotes literal.
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${productName}" "UninstallString" '"$INSTDIR\\Uninstall.exe"'
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${productName}" "QuietUninstallString" '"$INSTDIR\\Uninstall.exe" /S'

  CreateDirectory "$SMPROGRAMS\\${productName}"
  CreateShortCut "$SMPROGRAMS\\${productName}\\${productName}.lnk" "$INSTDIR\\${exeName}"
  CreateShortCut "$SMPROGRAMS\\${productName}\\Uninstall ${productName}.lnk" "$INSTDIR\\Uninstall.exe"
  CreateShortCut "$DESKTOP\\${productName}.lnk" "$INSTDIR\\${exeName}"

  ; The install notes travel with the install, so the SmartScreen prompt has an
  ; explanation next to it instead of only in a release page.
${writeNotes}
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\\${productName}.lnk"
  RMDir /r "$SMPROGRAMS\\${productName}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${productName}"
  DeleteRegKey HKCU "Software\\${productName}"
SectionEnd
`;
}

/**
 * Stages the Windows application directory.
 *
 * Mirrors `package-mac.sh`: the runtime is copied whole, the payload is written
 * under `resources/app`, the engine goes to `resources/bin`, and the app's own
 * `package.json` carries the version and build the window reports as itself.
 *
 * @param {{
 *   runtimeDir: string, helperPath: string, outDir: string, version: string,
 *   build: string, noticesPath?: string, endpoint?: string, appDirName?: string,
 * }} options
 * @returns {{ appDir: string, exe: string, helper: string, icon: string }}
 */
export function stageWindowsApp({
  runtimeDir,
  helperPath,
  outDir,
  version,
  build,
  noticesPath = join(PACKAGE_DIR, 'THIRD_PARTY_NOTICES.md'),
  endpoint = '',
  appDirName = APP_NAME,
  iconPath = '',
}) {
  for (const [label, input] of [
    ['Electron runtime', runtimeDir],
    ['engine binary', helperPath],
  ]) {
    if (!existsSync(input)) {
      throw new Error(`missing input: ${label} at ${input}`);
    }
  }
  const runtimeExe = join(runtimeDir, 'electron.exe');
  if (!existsSync(runtimeExe)) {
    throw new Error(`the runtime has no electron.exe: ${runtimeDir}`);
  }

  const appDir = join(outDir, appDirName);
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(runtimeDir, appDir, { recursive: true });

  // The process name is what Task Manager and the taskbar show; leaving it as
  // `electron.exe` is the vendor's name on the user's screen.
  const exe = join(appDir, APP_EXE);
  renameSync(join(appDir, 'electron.exe'), exe);

  const payload = join(appDir, 'resources', 'app');
  rmSync(payload, { recursive: true, force: true });
  mkdirSync(payload, { recursive: true });
  for (const entry of ['shell', 'agent', 'src']) {
    cpSync(join(PACKAGE_DIR, entry), join(payload, entry), { recursive: true });
  }
  mkdirSync(join(payload, 'packaging'), { recursive: true });
  cpSync(
    join(PACKAGE_DIR, 'packaging', 'version-contract.json'),
    join(payload, 'packaging', 'version-contract.json'),
  );
  writeFileSync(
    join(payload, 'package.json'),
    `${JSON.stringify(
      {
        name: 'anywhere-work',
        productName: APP_NAME,
        version,
        build,
        private: true,
        type: 'module',
        main: 'shell/main.mjs',
      },
      null,
      2,
    )}\n`,
  );
  if (endpoint) {
    writeFileSync(join(payload, 'endpoint.json'), `${JSON.stringify({ managementUrl: endpoint }, null, 2)}\n`);
  }
  if (existsSync(noticesPath)) {
    cpSync(noticesPath, join(payload, 'THIRD_PARTY_NOTICES.md'));
  }

  // Electron ships under MIT and Chromium ships its own third-party notice
  // bundle; both are distribution obligations of the packaged application.
  for (const licence of ['LICENSE', 'LICENSES.chromium.html']) {
    const from = join(runtimeDir, licence);
    if (existsSync(from)) {
      cpSync(from, join(appDir, licence));
    } else {
      console.warn(`warning: ${licence} is missing from the Electron runtime`);
    }
  }

  const binDir = join(appDir, 'resources', 'bin');
  mkdirSync(binDir, { recursive: true });
  const helper = join(binDir, ENGINE_NAME);
  cpSync(helperPath, helper);

  const icon = join(appDir, 'resources', 'app-icon.ico');
  // A pre-rendered icon is how a host that cannot execute the target runtime still
  // produces an installer with the product's icon: the packager renders through the
  // staged Electron on Windows, and takes the file verbatim everywhere else.
  if (iconPath !== '' && existsSync(iconPath)) {
    cpSync(iconPath, icon);
  }

  return { appDir, exe, helper, icon };
}

/** Minimal argument parsing: every value is explicit and nothing is inferred. */
export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--no-icon') {
      args.icon = false;
      continue;
    }
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`${token} needs a value`);
    }
    args[token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = next;
    index += 1;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const version =
    args.version ??
    JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'dsh-web-all', 'package.json'), 'utf8')).version;
  const build =
    args.build ??
    (spawnSync('git', ['-C', REPO_ROOT, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim();
  const outDir = resolve(args.out ?? join(PACKAGE_DIR, 'build'));
  const endpoint = args.endpoint ?? process.env.AW_MANAGEMENT_URL ?? '';

  const staged = stageWindowsApp({
    runtimeDir: resolve(args.runtime ?? ''),
    helperPath: resolve(args.helper ?? ''),
    outDir,
    version,
    build: build || '0',
    endpoint,
    iconPath: typeof args.icon === 'string' ? resolve(args.icon) : '',
  });

  if (args.icon === false || typeof args.icon === 'string') {
    if (typeof args.icon === 'string') {
      process.stdout.write(`==> icon: taken from ${resolve(args.icon)}\n`);
    }
  } else {
    const entries = renderIconPngs({
      runtimeExe: join(resolve(args.runtime ?? ''), 'electron.exe'),
      script: join(HERE, 'render-icon.cjs'),
      svg: join(PACKAGE_DIR, 'icons', 'app-icon.svg'),
      workDir: join(outDir, '.icon-work'),
    });
    writeFileSync(staged.icon, pngToIco(entries));
    rmSync(join(outDir, '.icon-work'), { recursive: true, force: true });
    process.stdout.write(`==> icon: ${entries.length} sizes from app-icon.svg\n`);
  }

  const installer = join(outDir, `${APP_NAME}-${version}-${build}.exe`);
  const nsi = join(outDir, `${APP_NAME}-${version}-${build}.nsi`);
  writeFileSync(
    nsi,
    renderNsisScript({
      appDir: staged.appDir,
      version,
      build: Number(build) || 0,
      outFile: installer,
      installNotes: readFileSync(join(PACKAGE_DIR, 'packaging', 'install-notes.txt'), 'utf8'),
      endpoint,
      iconPath: existsSync(staged.icon) ? staged.icon : '',
      // The staged tree as this host spells it: makensis needs the separator of the
      // machine it runs on, which is why this is computed here and not in the template.
      fileGlob: join(staged.appDir, '*.*'),
      notesPath: join(PACKAGE_DIR, 'packaging', 'install-notes.txt'),
    }),
  );

  process.stdout.write(`==> staged ${staged.appDir}\n`);
  process.stdout.write(`==> wrote ${nsi}\n`);
  process.stdout.write(`==> installer would be ${installer}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`package-windows: ${error.message}\n`);
    process.exitCode = 1;
  }
}