import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KERNEL_PORT,
  NODE_MIN_MAJOR,
  PLUGIN_CONTRACT_PATH,
  binaryCandidatePatterns,
  createKernelSupervisor,
  machineLabel,
  nodeCandidatePatterns,
  parseNodeMajor,
  parseNodeVersion,
  parseVersion,
  portAnswers,
  shellQuote,
  trustedHost,
} from '../agent/kernel.mjs';

/** A scripted command runner that records what it was asked to do. */
function fakeRun(script = {}) {
  const calls = [];
  return {
    calls,
    run: async (command, args) => {
      const key = [command, ...args].join(' ');
      calls.push(key);
      const answer = script[key];
      if (answer === undefined) {
        return { code: 1, stdout: '', stderr: `unexpected command: ${key}` };
      }
      const value = typeof answer === 'function' ? answer() : answer;
      return typeof value === 'string' ? { code: 0, stdout: value, stderr: '' } : value;
    },
  };
}

const PATHS = { home: '/Users/someone', dshHome: '/Users/someone/.dsh' };

function supervisor(script, options = {}) {
  const runner = fakeRun(script);
  return {
    runner,
    kernel: createKernelSupervisor({
      run: runner.run,
      probe: options.probe ?? (async () => 0),
      platform: options.platform ?? 'darwin',
      paths: PATHS,
      resolveBinary: options.resolveBinary,
      installCommand: options.installCommand,
      log: () => {},
    }),
  };
}

/** The machine has a usable Node and the host on PATH. */
const MODERN_NODE = {
  'sh -lc command -v node': '/usr/local/bin/node',
  '/usr/local/bin/node -v': 'v22.19.0',
  'sh -c test -x \'/usr/local/bin/npm\'': '',
};

const INSTALL_COMMAND = 'curl -fsSL https://channel.example/install.sh | sh';

test('the machine label follows the fleet installer rules', () => {
  assert.equal(machineLabel('Studio-Macbook.vpn'), 'studio-macbook');
  assert.equal(machineLabel('ZCX.T470P'), 'zcx');
  assert.equal(machineLabel('weird name!!'), 'weird-name');
  assert.equal(machineLabel('trailing---'), 'trailing');
  assert.equal(machineLabel(''), 'localhost');
  assert.equal(machineLabel(undefined), 'localhost');
  assert.equal(machineLabel('---'), 'localhost');
});

test('the canonical authority is dsh.<machine>.netbird', () => {
  assert.equal(trustedHost('studio-macbook.vpn'), 'dsh.studio-macbook.netbird');
  assert.equal(trustedHost(''), 'dsh.localhost.netbird');
});

test('the layouts a GUI launch cannot see are named, not guessed', () => {
  // The bug this pins: an app launched from Finder inherits launchd's minimal PATH, so
  // a Node under nvm or the private runtime the installer wrote were both invisible and
  // the app fetched its own archive every start.
  const nodes = nodeCandidatePatterns('/Users/someone', '/Users/someone/.dsh');
  for (const expected of [
    '/Users/someone/.dsh/node/*/bin/node',
    '/Users/someone/.nvm/versions/node/*/bin/node',
    '/Users/someone/.volta/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ]) {
    assert.ok(nodes.includes(expected), expected);
  }
  const hosts = binaryCandidatePatterns('/Users/someone', '/Users/someone/.dsh');
  assert.ok(hosts.includes('/Users/someone/.nvm/versions/node/*/bin/dsh'));
  assert.ok(hosts.includes('/Users/someone/.dsh/node/*/bin/dsh'));
});

test('a Node a GUI launch cannot see is detected, and nothing is downloaded', async () => {
  const nvmDir = '/Users/someone/.nvm/versions/node/v22.22.0';
  const nvmNode = `${nvmDir}/bin/node`;
  let binaryReads = 0;
  const { kernel, runner } = supervisor(
    {
      'sh -lc command -v node': { code: 1, stdout: '', stderr: '' },
      [`sh -lc ls -1d '/Users/someone/.nvm/versions/node/'*/bin/node 2>/dev/null`]: `${nvmNode}\n`,
      [`${nvmNode} -v`]: 'v22.22.0',
      [`sh -c test -x '${nvmDir}/bin/npm'`]: '',
    },
    {
      resolveBinary: async () => {
        binaryReads += 1;
        return binaryReads === 1 ? '' : '/opt/dsh';
      },
    },
  );

  const result = await kernel.ensure();

  // The host is missing, so this is a hand-off - but the hand-off proves detection
  // worked: it names the runtime it found instead of asking for one.
  assert.equal(result.action, 'needs-host');
  assert.match(result.reason, /Node 22/);
  assert.equal(runner.calls.some((call) => /curl|tar|npm install/.test(call)), false, 'nothing may be installed or fetched');
  const runtime = await kernel.runtime();
  assert.equal(runtime.binary, nvmNode);
  assert.equal(runtime.major, 22);
  assert.equal(runtime.source, nvmNode);
});

test('a private runtime installed earlier is reused rather than fetched again', async () => {
  const dir = `${PATHS.dshHome}/node/node-v22.19.0-darwin-arm64`;
  const privateNode = `${dir}/bin/node`;
  let binaryReads = 0;
  const { kernel, runner } = supervisor(
    {
      'sh -lc command -v node': { code: 1, stdout: '', stderr: '' },
      [`sh -lc ls -1d '${PATHS.dshHome}/node/'*/bin/node 2>/dev/null`]: `${privateNode}\n`,
      [`${privateNode} -v`]: 'v22.19.0',
      [`sh -c test -x '${dir}/bin/npm'`]: '',
    },
    {
      resolveBinary: async () => {
        binaryReads += 1;
        return binaryReads === 1 ? '' : '/opt/dsh';
      },
    },
  );

  const result = await kernel.ensure();

  assert.equal(result.action, 'needs-host');
  assert.equal(runner.calls.some((call) => /curl|tar/.test(call)), false, 'a runtime already on disk is never fetched again');
});

test('the fleet runtime major wins over a newer one, and the newest of that major', async () => {
  const nvm = '/Users/someone/.nvm/versions/node';
  const older22 = `${nvm}/v22.11.0/bin/node`;
  const newer22 = `${nvm}/v22.22.0/bin/node`;
  const node24 = `${nvm}/v24.12.0/bin/node`;
  const { kernel } = supervisor(
    {
      'sh -lc command -v node': { code: 1, stdout: '', stderr: '' },
      [`sh -lc ls -1d '${nvm}/'*/bin/node 2>/dev/null`]: `${older22}\n${node24}\n${newer22}\n`,
      [`${older22} -v`]: 'v22.11.0',
      [`${newer22} -v`]: 'v22.22.0',
      [`${node24} -v`]: 'v24.12.0',
      [`sh -c test -x '${nvm}/v22.11.0/bin/npm'`]: '',
      [`sh -c test -x '${nvm}/v22.22.0/bin/npm'`]: '',
      [`sh -c test -x '${nvm}/v24.12.0/bin/npm'`]: '',
    },
    { resolveBinary: async () => '/opt/dsh' },
  );

  const runtime = await kernel.runtime();

  // 22 is the runtime the fleet installer ships and the harness is verified against, and
  // the newest 22 is the one this machine's own service runs.
  assert.equal(runtime.binary, newer22);
  assert.equal(runtime.major, 22);
});

test('a ready machine is left alone', async () => {
  const { kernel, runner } = supervisor(
    {},
    { resolveBinary: async () => '/opt/dsh', probe: async () => 200 },
  );

  const status = await kernel.status();

  assert.equal(status.installed, true);
  assert.equal(status.reachable, true);
  assert.equal(status.plugins, true);
  assert.equal((await kernel.ensure()).action, 'present');
  // The kernel has no write surface at all: it exposes three readers and nothing else,
  // and no command it runs downloads, installs or registers anything.
  assert.deepEqual(Object.keys(kernel).sort(), ['ensure', 'runtime', 'status']);
  assert.equal(
    runner.calls.some((call) => /curl|tar -xzf|install -g|npm install|launchctl|systemctl/.test(call)),
    false,
    `a ready machine is only read: ${runner.calls.join(' | ')}`,
  );
});

test('a host that does not serve our plugin is a hand-off, not a silent success', async () => {
  // The plugin is what makes the workspace this product; a bare DSH answering on the
  // port is exactly the state a person cannot tell from a working one.
  const { kernel, runner } = supervisor(
    { ...MODERN_NODE },
    {
      resolveBinary: async () => '/opt/dsh',
      probe: async (url) => (url.endsWith(PLUGIN_CONTRACT_PATH) ? 404 : 200),
      installCommand: INSTALL_COMMAND,
    },
  );

  const result = await kernel.ensure();

  assert.equal(result.action, 'needs-plugin');
  assert.equal(result.command, INSTALL_COMMAND);
  assert.match(result.reason, /not serving our plugin/);
  assert.match(result.reason, /404/);
  assert.equal(
    runner.calls.some((call) => /curl|tar -xzf|install -g|npm install/.test(call)),
    false,
    'the app installs nothing',
  );
});

test('a host that is installed but silent is named as such', async () => {
  const { kernel } = supervisor(
    { ...MODERN_NODE },
    { resolveBinary: async () => '/opt/dsh', probe: async () => 0, installCommand: INSTALL_COMMAND },
  );

  const result = await kernel.ensure();

  assert.equal(result.action, 'needs-service');
  assert.match(result.reason, /nothing answers on 127\.0\.0\.1:3080/);
});

test('a machine with no runtime is handed the installer command, not a download', async () => {
  const { kernel, runner } = supervisor(
    { 'sh -lc command -v node': { code: 1, stdout: '', stderr: '' } },
    { resolveBinary: async () => '', installCommand: INSTALL_COMMAND },
  );

  const result = await kernel.ensure();

  assert.equal(result.action, 'needs-runtime');
  assert.equal(result.command, INSTALL_COMMAND);
  assert.match(result.reason, /installs nothing itself/);
  assert.equal(runner.calls.some((call) => /curl|tar|npm/.test(call)), false, 'the app installs nothing');
});

test('a machine with a runtime but no host is handed the same command', async () => {
  const { kernel, runner } = supervisor(
    { ...MODERN_NODE },
    { resolveBinary: async () => '', installCommand: INSTALL_COMMAND },
  );

  const result = await kernel.ensure();

  assert.equal(result.action, 'needs-host');
  assert.equal(result.command, INSTALL_COMMAND);
  assert.match(result.reason, /no DSH host/);
  assert.equal(runner.calls.some((call) => /install -g|curl|tar/.test(call)), false, 'the host is not installed here');
});

test('without a configured channel the hand-off still names the way out', async () => {
  const { kernel } = supervisor(
    { 'sh -lc command -v node': { code: 1, stdout: '', stderr: '' } },
    { resolveBinary: async () => '' },
  );

  const result = await kernel.ensure();

  assert.equal(result.action, 'needs-runtime');
  assert.equal(result.command, '');
  assert.match(result.reason, /install it yourself/);
});

test('status reads the machine and reports what it found', async () => {
  const { kernel, runner } = supervisor(
    { '/opt/dsh --version': 'dsh 0.2.0-rc.2' },
    {
      probe: async (url) => (url.endsWith(PLUGIN_CONTRACT_PATH) ? 200 : 302),
      resolveBinary: async () => '/opt/dsh',
    },
  );

  const status = await kernel.status();

  assert.equal(status.installed, true);
  assert.equal(status.reachable, true);
  assert.equal(status.statusCode, 302);
  assert.equal(status.version, '0.2.0-rc.2');
  assert.equal(status.plugins, true);
  assert.equal(status.pluginStatusCode, 200);
  // The only commands are lookups and one version query; nothing here writes or installs.
  assert.equal(
    runner.calls.some((call) => /curl|tar -xzf|install -g|npm install|launchctl|systemctl/.test(call)),
    false,
    runner.calls.join(' | '),
  );
});

test('the version is asked with the runtime on PATH, since dsh is a node script', async () => {
  const nvmDir = '/Users/someone/.nvm/versions/node/v22.22.0';
  const nvmNode = `${nvmDir}/bin/node`;
  const { kernel, runner } = supervisor(
    {
      'sh -lc command -v node': { code: 1, stdout: '', stderr: '' },
      [`sh -lc ls -1d '/Users/someone/.nvm/versions/node/'*/bin/node 2>/dev/null`]: `${nvmNode}\n`,
      [`${nvmNode} -v`]: 'v22.22.0',
      [`sh -c test -x '${nvmDir}/bin/npm'`]: '',
      [`sh -lc PATH='${nvmDir}/bin':$PATH '/opt/dsh' --version`]: 'dsh 0.2.0-rc.2\n',
    },
    { probe: async () => 200, resolveBinary: async () => '/opt/dsh' },
  );

  const status = await kernel.status();

  assert.equal(status.version, '0.2.0-rc.2');
  assert.equal(status.plugins, true);
});

test('status reports an absent host without pretending', async () => {
  const { kernel } = supervisor({}, { probe: async () => 0, resolveBinary: async () => '' });
  const status = await kernel.status();
  assert.equal(status.installed, false);
  assert.equal(status.reachable, false);
  assert.equal(status.version, '');
  assert.equal(status.binary, '');
  assert.equal(status.plugins, false, 'an unreachable host is never credited with the plugin');
});

test('the port counts as served for any HTTP answer', () => {
  assert.equal(portAnswers(200), true);
  assert.equal(portAnswers(302), true);
  assert.equal(portAnswers(401), true);
  assert.equal(portAnswers(599), true);
  assert.equal(portAnswers(0), false);
  assert.equal(portAnswers(600), false);
  assert.equal(portAnswers('nope'), false);
});

test('versions are read defensively', () => {
  assert.equal(parseVersion('dsh 0.2.0-rc.2\n'), '0.2.0-rc.2');
  assert.equal(parseVersion('nonsense'), '');
  assert.equal(parseNodeMajor('v22.19.0'), 22);
  assert.equal(parseNodeMajor('20.11.1\n'), 20);
  assert.equal(parseNodeMajor('v'), 0);
  assert.deepEqual(parseNodeVersion('v22.22.0'), { major: 22, minor: 22, patch: 0 });
  assert.deepEqual(parseNodeVersion('v'), { major: 0, minor: 0, patch: 0 });
  assert.equal(NODE_MIN_MAJOR, 22);
  assert.equal(KERNEL_PORT, 3080);
  assert.equal(shellQuote('/Users/a b/.dsh'), `'/Users/a b/.dsh'`);
  assert.equal(shellQuote(`it's`), `'it'\\''s'`);
});