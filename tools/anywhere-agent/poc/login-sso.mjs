#!/usr/bin/env node
/**
 * PoC: enroll this machine as an app-scoped peer through the unified SSO.
 *
 * The point is what the engine does NOT do: the peer is registered from a private
 * config/state directory, no system interface is created, and the system resolver
 * is never touched. Nothing about the machine's networking changes; only this
 * process gains the overlay.
 *
 * Usage:
 *   node poc/login-sso.mjs [--binary <path>] [--dir <private state dir>]
 *
 * The printed URL is the same PKCE hand-off the mobile client uses: the browser
 * completes Feishu sign-in and the helper's loopback callback receives the token.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { TunnelClient } from '../src/tunnel-client.mjs';

function parseArgs(argv) {
  const args = {
    binary: join(homedir(), '.cache/anywhere-agent/bin/anywhere-tunnel'),
    dir: join(homedir(), '.anywhere-poc'),
    managementUrl: 'https://netbird.example.com:443',
    deviceName: 'anywhere-poc',
    watch: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--binary') args.binary = value;
    else if (key === '--dir') args.dir = value;
    else if (key === '--management-url') args.managementUrl = value;
    else if (key === '--device-name') args.deviceName = value;
    else if (key === '--watch') args.watch = true;
    // A boolean flag must not consume the next argument: doing so swallowed the
    // following option (for example `--engine --dir X` lost the directory) and the
    // run then quietly used a default profile instead.
    if (!['--watch'].includes(key)) i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
mkdirSync(args.dir, { recursive: true, mode: 0o700 });

const configPath = join(args.dir, 'config.json');
const statePath = join(args.dir, 'state.json');

const client = new TunnelClient({ binary: args.binary, onStderr: (line) => process.stderr.write(`[engine] ${line}\n`) });
client.start();

const version = await client.version();
process.stdout.write(`engine=${JSON.stringify(version)}\n`);
process.stdout.write(`privateConfig=${configPath}\nprivateState=${statePath}\n`);

const already = await client.request('sso-configured', {
  managementUrl: args.managementUrl,
  configPath,
});
process.stdout.write(`ssoConfigured=${already}\n`);

if (!already) {
  const url = await client.request('login', {
    deviceName: args.deviceName,
    managementUrl: args.managementUrl,
    configPath,
    statePath,
  });
  process.stdout.write(`LOGIN_URL=${url}\n`);
  process.stdout.write('等待浏览器完成登录;完成后本进程会打印状态变化。\n');
}

const watch = async () => {
  for (;;) {
    try {
      const status = await client.request('sso-status');
      process.stdout.write(`ssoStatus=${JSON.stringify(status)}\n`);
      const text = JSON.stringify(status);
      // The engine reports "waiting" until the loopback callback carries the code
      // back, then "done". Matching only the finished states keeps the loop from
      // exiting on the URL it is still waiting for.
      if (/"state"\s*:\s*"(done|complete|success|connected|ok)"/i.test(text)) {
        process.stdout.write('SSO_READY\n');
        return;
      }
    } catch (error) {
      process.stdout.write(`ssoStatus error: ${error.message}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
};

if (args.watch) {
  await watch();
} else {
  process.stdout.write('进程保持存活以接收回环回调;结束请杀掉本进程。\n');
}