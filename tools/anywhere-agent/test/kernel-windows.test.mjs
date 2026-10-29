import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  binaryCandidatePatterns,
  commandSet,
  createKernelSupervisor,
  nodeCandidatePatterns,
  powerShellQuote,
} from '../agent/kernel.mjs';

const PATHS = { home: 'C:\\Users\\someone', dshHome: 'C:\\Users\\someone\\.dsh' };

/** A runner that answers by matching a fragment of the recorded command. */
function scriptedRun(answers) {
  const calls = [];
  return {
    calls,
    run: async (command, args) => {
      const key = [command, ...args].join(' ');
      calls.push(key);
      for (const [needle, answer] of answers) {
        if (key.includes(needle)) {
          const value = typeof answer === 'function' ? answer(key) : answer;
          return typeof value === 'string' ? { code: 0, stdout: value, stderr: '' } : value;
        }
      }
      return { code: 1, stdout: '', stderr: `unexpected command: ${key}` };
    },
  };
}

function supervisorWindows(script, options = {}) {
  return createKernelSupervisor({
    run: script.run,
    probe: async () => 200,
    platform: 'win32',
    paths: PATHS,
    installCommand: 'iwr https://anywhere.example.com/install.ps1 | iex',
    ...options,
  });
}

test('Windows node layouts are the ones Windows actually uses', () => {
  const patterns = nodeCandidatePatterns(PATHS.home, PATHS.dshHome, 'win32');
  assert.ok(patterns.includes('C:\\Users\\someone\\.dsh\\node\\*\\node.exe'), 'the fleet runtime');
  assert.ok(patterns.includes('C:\\Users\\someone\\AppData\\Roaming\\npm\\node.exe'), 'a global npm install');
  assert.ok(patterns.includes('C:\\Users\\someone\\AppData\\Roaming\\nvm\\*\\node.exe'), 'nvm-windows');
  assert.ok(patterns.includes('C:\\Users\\someone\\AppData\\Local\\Volta\\bin\\node.exe'), 'Volta');
  assert.ok(patterns.includes('C:\\Program Files\\nodejs\\node.exe'), 'Program Files');
  assert.ok(
    patterns.every((pattern) => pattern.endsWith('node.exe')),
    'every candidate is an executable, not a POSIX script',
  );

  const hosts = binaryCandidatePatterns(PATHS.home, PATHS.dshHome, 'win32');
  assert.ok(hosts.includes('C:\\Users\\someone\\AppData\\Roaming\\npm\\dsh.cmd'), 'npm writes .cmd shims');
  assert.ok(hosts.every((pattern) => /\.(cmd|exe)$/.test(pattern)));
});

test('POSIX layouts are untouched by the addition', () => {
  const patterns = nodeCandidatePatterns('/Users/someone', '/Users/someone/.dsh');
  assert.ok(patterns.includes('/Users/someone/.nvm/versions/node/*/bin/node'));
  assert.equal(patterns.includes('/Users/someone/AppData/Roaming/npm/node.exe'), false);
  const hosts = binaryCandidatePatterns('/Users/someone', '/Users/someone/.dsh');
  assert.ok(hosts.includes('/opt/homebrew/bin/dsh'));
});

test('the Windows command set is PowerShell, not a missing sh', () => {
  const commands = commandSet('win32');
  const [which, whichArgs] = commands.which('node');
  assert.equal(which, 'powershell.exe');
  assert.deepEqual(whichArgs.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(whichArgs[3], /Get-Command node -ErrorAction SilentlyContinue/);

  const [glob, globArgs] = commands.glob('C:\\Users\\someone\\AppData\\Roaming\\nvm\\*\\node.exe');
  assert.equal(glob, 'powershell.exe');
  assert.match(globArgs[3], /Get-Item -Path 'C:\\Users\\someone\\AppData\\Roaming\\nvm\\\*\\node\.exe'/);

  const [test_, testArgs] = commands.isExecutable('C:\\Program Files\\nodejs\\npm.cmd');
  assert.match(testArgs[3], /Test-Path -LiteralPath 'C:\\Program Files\\nodejs\\npm\.cmd' -PathType Leaf/);
  assert.match(testArgs[3], /exit 0/, 'a missing file must not exit 0');

  const [withPath, withPathArgs] = commands.withPath('C:\\Program Files\\nodejs', 'C:\\dsh\\dsh.cmd', ['--version']);
  assert.match(withPathArgs[3], /\+ ';' \+ \$env:PATH/, 'Windows separates PATH entries with a semicolon');
  assert.match(withPathArgs[3], /& 'C:\\dsh\\dsh\.cmd' --version/);
  assert.equal(withPath, 'powershell.exe');

  assert.equal(commands.npmName, 'npm.cmd');
  assert.equal(commands.dshName, 'dsh.cmd');
  assert.equal(commands.dirOf('C:\\Program Files\\nodejs\\node.exe'), 'C:\\Program Files\\nodejs');
  assert.equal(commands.join('C:\\Program Files\\nodejs', 'npm.cmd'), 'C:\\Program Files\\nodejs\\npm.cmd');
});

test('PowerShell quoting doubles a quote instead of backslashing it', () => {
  assert.equal(powerShellQuote("C:\\it's here\\node.exe"), "'C:\\it''s here\\node.exe'");
  assert.equal(commandSet('darwin').which('node')[0], 'sh', 'POSIX still asks sh');
});

test('a Windows machine with Node and DSH on PATH is ready, read through PowerShell', async () => {
  const script = scriptedRun([
    ['Get-Command node', 'C:\\Program Files\\nodejs\\node.exe'],
    ['node.exe -v', 'v22.22.0\n'],
    ['Test-Path', { code: 0, stdout: 'True\n', stderr: '' }],
    ['Get-Command dsh.cmd', 'C:\\Users\\someone\\AppData\\Roaming\\npm\\dsh.cmd'],
    ['$env:PATH', 'dsh 0.4.6\n'],
  ]);
  const kernel = supervisorWindows(script);

  const runtime = await kernel.runtime();
  assert.equal(runtime.binary, 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(runtime.npm, 'C:\\Program Files\\nodejs\\npm.cmd', 'npm is looked for as npm.cmd');
  assert.equal(runtime.major, 22);

  const status = await kernel.status();
  assert.equal(status.installed, true);
  assert.equal(status.binary, 'C:\\Users\\someone\\AppData\\Roaming\\npm\\dsh.cmd');
  assert.equal(status.version, '0.4.6');
  assert.equal(status.reachable, true);
  assert.equal(status.plugins, true, 'the plugin probe answered 200');

  assert.ok(
    script.calls.every((call) => !call.startsWith('sh ')),
    `no POSIX shell on Windows, got: ${script.calls.join(' | ')}`,
  );
  assert.ok(
    script.calls.some((call) => call.includes('$env:PATH') && call.includes("';'")),
    'the host version is asked with the runtime directory prepended',
  );
});

test('with nothing on PATH, Windows layouts are globbed and a miss is reported', async () => {
  const nvmNode = 'C:\\Users\\someone\\AppData\\Roaming\\nvm\\v22.22.0\\node.exe';
  const script = scriptedRun([
    ['Get-Command node', { code: 1, stdout: '', stderr: '' }],
    ['Get-Item -Path', `${nvmNode}\r\n`],
    ['node.exe -v', 'v22.22.1\n'],
    ['Test-Path', { code: 0, stdout: 'True\n', stderr: '' }],
    ['Get-Command dsh.cmd', { code: 1, stdout: '', stderr: '' }],
  ]);
  const kernel = supervisorWindows(script);

  const runtime = await kernel.runtime();
  assert.equal(runtime.binary, nvmNode, 'the nvm-windows layout is read');
  assert.equal(runtime.npm, 'C:\\Users\\someone\\AppData\\Roaming\\nvm\\v22.22.0\\npm.cmd');

  const ensured = await kernel.ensure({ installed: false, reachable: false, plugins: false });
  assert.equal(ensured.action, 'needs-host');
  assert.match(ensured.reason, /no DSH host this app can see/);
  assert.match(ensured.command, /install\.ps1/, 'the Windows command is handed over, not the POSIX one');
});

test('a Windows machine without a usable runtime is told which layer is missing', async () => {
  const script = scriptedRun([
    ['Get-Command node', { code: 1, stdout: '', stderr: '' }],
    ['Get-Item -Path', { code: 1, stdout: '', stderr: '' }],
  ]);
  const kernel = supervisorWindows(script);
  const ensured = await kernel.ensure({ installed: true, reachable: true, plugins: false });
  assert.equal(ensured.action, 'needs-runtime', 'a host without a runtime still cannot be reported ready');
  assert.match(ensured.reason, /no Node 22 or newer/);
});