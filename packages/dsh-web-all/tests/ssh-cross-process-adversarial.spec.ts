import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'

// Production is imported unchanged by independent Node processes. The first
// process pauses immediately before its real atomic rename, representing OS
// preemption: no callback re-enters HostStore on the same JS stack.
const childSource = `
  import fs from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  import { pathToFileURL } from 'node:url';
  const [source, storePath, alias, readyPath, releasePath] = process.argv.slice(1);
  const realRename = fs.renameSync;
  if (readyPath) {
    fs.renameSync = (from, to) => {
      if (to === storePath) {
        fs.writeFileSync(readyPath, 'paused-before-rename');
        const deadline = Date.now() + 5000;
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(releasePath)) {
          if (Date.now() > deadline) throw new Error('fixture release barrier timed out');
          Atomics.wait(wait, 0, 0, 5);
        }
      }
      return realRename(from, to);
    };
    syncBuiltinESMExports();
  }
  try {
    const { HostStore } = await import(pathToFileURL(source).href);
    const store = new HostStore(storePath, storePath + '.absent-ssh-config');
    process.stdout.write('begin\\n');
    store.upsert({ alias, host: 'fixture.invalid', port: 22, user: 'fixture',
      auth: { kind: 'password', password: 'ephemeral-test-only' }, proxyJump: [], tags: [] });
    process.stdout.write('committed\\n');
  } catch (error) {
    process.stderr.write(String(error.stack || error));
    process.exitCode = 1;
  }
`

interface Writer {
  process: ChildProcess
  done: Promise<{ code: number | null; stdout: string; stderr: string }>
  began: Promise<void>
}
function writer(source: string, store: string, alias: string, ready = '', release = ''): Writer {
  const child = spawn(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', childSource, source, store, alias, ready, release], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Bound only these fixture processes; never discover or signal a DSH host.
    timeout: 7000,
    killSignal: 'SIGKILL',
    env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1' },
  })
  let stdout = ''; let stderr = ''
  let begin!: () => void
  const began = new Promise<void>(yes => { begin = yes })
  child.stdout!.on('data', data => { stdout += String(data); if (stdout.includes('begin\n')) begin() })
  child.stderr!.on('data', data => { stderr += String(data) })
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((yes, no) => {
    child.once('error', no)
    child.once('close', code => { yes({ code, stdout, stderr }) })
  })
  return { process: child, done, began }
}
async function bounded<T>(promise: Promise<T>, name: string, timeout = 6000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`fixture timeout: ${name}`)), timeout) })])
  } finally { clearTimeout(timer) }
}

describe('SSH credential store cross-process writers', () => {
  it('preserves both independently successful writes when one process is preempted before rename', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ssh-cross-process-')))
    const path = join(root, 'hosts.json')
    const ready = join(root, 'first-ready')
    const release = join(root, 'release-first')
    const source = new URL('../src/host/services/ssh/store.ts', import.meta.url).pathname
    const children: Writer[] = []
    writeFileSync(path, JSON.stringify({ version: 1, hosts: [] }))
    try {
      const first = writer(source, path, 'first-writer', ready, release); children.push(first)
      await bounded((async () => { while (!existsSync(ready)) await delay(5) })(), 'first writer reached real rename')
      const second = writer(source, path, 'second-writer'); children.push(second)
      await bounded(Promise.race([second.began, second.done.then(result => { throw new Error(`second writer failed to start: ${JSON.stringify(result)}`) })]), 'second writer begins')
      // With a real cross-process lock, writer two blocks while writer one holds
      // ownership. Release promptly in that case; an unlocked writer commits now.
      await Promise.race([second.done, delay(200)])
      writeFileSync(release, 'continue')
      const results = await bounded(Promise.all([first.done, second.done]), 'both writer results')
      expect(results.map(result => ({ code: result.code, stdout: result.stdout, stderr: result.stderr })), 'both actual upserts must complete successfully').toEqual([
        { code: 0, stdout: 'begin\ncommitted\n', stderr: '' },
        { code: 0, stdout: 'begin\ncommitted\n', stderr: '' },
      ])
      const committed = JSON.parse(readFileSync(path, 'utf8')) as { hosts: Array<{ alias: string }> }
      expect(committed.hosts.map(host => host.alias).sort(), 'atomic rename must not discard another process\'s acknowledged successful update').toEqual(['first-writer', 'second-writer'])
    } finally {
      if (!existsSync(release)) writeFileSync(release, 'teardown')
      await bounded(Promise.all(children.map(child => child.done)), 'child cleanup')
      // Every child has exited before deleting its checked, fixture-only root.
      expect(resolve(root)).toBe(root)
      expect(root.startsWith(`${realpathSync(tmpdir())}/ssh-cross-process-`)).toBe(true)
      expect(realpathSync(root)).toBe(root)
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)
})
