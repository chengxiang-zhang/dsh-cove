import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TunnelClient } from '../src/tunnel-client.mjs';

/**
 * A helper that speaks the protocol and never answers `stop`.
 *
 * That is the shape a real engine has while it is mid-sign-in: the window asks it to stop
 * because the person gave up, and the answer does not come.
 */
function helperThatIgnoresStop() {
  const file = join(mkdtempSync(join(tmpdir(), 'aw-helper-')), 'helper.mjs');
  writeFileSync(
    file,
    [
      '#!/usr/bin/env node',
      'process.stdin.setEncoding("utf8");',
      'let buffer = "";',
      'process.stdin.on("data", (chunk) => {',
      '  buffer += chunk;',
      '  let index;',
      '  while ((index = buffer.indexOf("\\n")) !== -1) {',
      '    const line = buffer.slice(0, index);',
      '    buffer = buffer.slice(index + 1);',
      '    try {',
      '      const request = JSON.parse(line);',
      '      if (request.cmd !== "stop") {',
      '        process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: "pong" })}\\n`);',
      '      }',
      '    } catch {',
      '      // An unparsable line is not this helper\'s business.',
      '    }',
      '  }',
      '});',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return file;
}

test('stopping does not wait on an engine that never answers', async () => {
  const client = new TunnelClient({ binary: helperThatIgnoresStop(), stopTimeoutMs: 120 });
  client.start();
  assert.equal(await client.request('version'), 'pong', 'the helper is up and answering');

  const started = Date.now();
  await client.stop();
  const elapsed = Date.now() - started;
  // The request timeout is two minutes, which is how "暂不登录" became a button that looked
  // like it did nothing: the window waited for an engine that was busy signing in.
  assert.ok(elapsed < 3_000, `stop returned in ${elapsed}ms instead of the request timeout`);
  // And it still terminates the process rather than leaving it behind.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(client.child, null, 'the helper is gone');
});

test('an engine that dies on its own is reported, one that is stopped is not', async () => {
  // The shell's crash recovery hangs off this distinction: reporting an intentional stop
  // would restart the engine the user just turned off, forever.
  const exits = [];
  const client = new TunnelClient({ binary: helperThatIgnoresStop(), stopTimeoutMs: 120, onExit: (info) => exits.push(info) });
  client.start();
  await client.request('version');
  client.child.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(exits.length, 1, 'a helper that died without being asked is one crash');
  assert.equal(client.child, null);

  const stopped = [];
  const second = new TunnelClient({ binary: helperThatIgnoresStop(), stopTimeoutMs: 120, onExit: (info) => stopped.push(info) });
  second.start();
  await second.request('version');
  await second.stop();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(stopped.length, 0, 'stopping on purpose is not a crash');
});