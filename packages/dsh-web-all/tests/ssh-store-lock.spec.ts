import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { HostStore, HostStoreBusyError } from '../src/host/services/ssh/store.ts'

const source = new URL('../src/host/services/ssh/store.ts', import.meta.url).pathname
const input = (alias: string) => ({ alias, host: 'fixture.invalid', user: 'fixture', port: 22, auth: { kind: 'agent' as const }, proxyJump: [], tags: [] })
const childSource = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
const [source, path, mode, alias, timeout] = process.argv.slice(1);
const rename = fs.renameSync;
const write = fs.writeFileSync;
if (mode === 'pause' || mode === 'crash') fs.renameSync = (from, to) => {
  if (to === path) {
    fs.writeFileSync(path + '.ready', 'ready');
    if (mode === 'crash') process.exit(17);
    const deadline = Date.now() + 5000;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(path + '.release')) {
      if (Date.now() > deadline) throw new Error('fixture barrier timeout');
      Atomics.wait(wait, 0, 0, 5);
    }
  }
  return rename(from, to);
};
if (mode === 'fail') fs.renameSync = () => { throw new Error('fixture save failure'); };
if (mode === 'tamper' || mode === 'replace') fs.writeFileSync = (file, ...args) => {
  const result = write(file, ...args);
  if (typeof file === 'number') {
    if (mode === 'replace') fs.renameSync(path + '.lock', path + '.stolen');
    write(path + '.lock', 'foreign-owner');
  }
  return result;
};
syncBuiltinESMExports();
const { HostStore } = await import(pathToFileURL(source).href);
const store = new HostStore(path, path + '.config', { lockTimeoutMs: Number(timeout) });
try {
  if (mode === 'import') store.importSshConfig();
  else if (mode === 'remove') store.remove(alias);
  else store.upsert({ alias, host:'fixture.invalid', user:'fixture', port:22, auth:{kind:'agent'}, proxyJump:[], tags:[] });
  process.stdout.write('success');
} catch (error) { process.stderr.write(String(error.code || '') + ':' + error.message); process.exitCode = 1; }
`
function child(path: string, mode: string, alias = mode, timeout = 2000) {
  const process = spawn(globalThis.process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', childSource, source, path, mode, alias, String(timeout)], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 7000, killSignal: 'SIGKILL', env: { PATH: globalThis.process.env.PATH, NODE_NO_WARNINGS: '1' },
  })
  let stdout = ''; let stderr = ''
  process.stdout.on('data', data => { stdout += String(data) })
  process.stderr.on('data', data => { stderr += String(data) })
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((yes, no) => {
    process.once('error', no)
    process.once('close', code => { yes({ code, stdout, stderr }) })
  })
  return { done }
}
async function fixture(run: (path: string, jobs: Array<ReturnType<typeof child>>) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ssh-store-lock-')))
  const path = join(root, 'hosts.json')
  const jobs: Array<ReturnType<typeof child>> = []
  try { await run(path, jobs) } finally {
    writeFileSync(path + '.release', 'cleanup')
    await Promise.all(jobs.map(job => job.done))
    expect(resolve(root)).toBe(root)
    expect(realpathSync(root)).toBe(root)
    expect(root.startsWith(`${realpathSync(tmpdir())}/ssh-store-lock-`)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
}
async function ready(path: string) {
  const deadline = Date.now() + 4000
  while (!existsSync(path + '.ready')) {
    if (Date.now() > deadline) throw new Error('fixture child failed to reach held lock')
    await delay(5)
  }
}

describe('SSH host store bounded process lock', () => {
  it('reloads after acquiring the lock and preserves two successful child writes', async () => {
    await fixture(async (path, jobs) => {
      const first = child(path, 'pause', 'first'); jobs.push(first)
      await ready(path)
      const second = child(path, 'write', 'second'); jobs.push(second)
      await delay(100)
      writeFileSync(path + '.release', 'go')
      expect(await first.done).toEqual({ code: 0, stdout: 'success', stderr: '' })
      expect(await second.done).toEqual({ code: 0, stdout: 'success', stderr: '' })
      expect(new HostStore(path).list().map(entry => entry.alias).sort()).toEqual(['first', 'second'])
      expect(existsSync(path + '.lock')).toBe(false)
    })
  })

  it.each(['write', 'remove', 'import'])('bounds contended %s and does not steal a live writer lock', async mode => {
    await fixture(async (path, jobs) => {
      const store = new HostStore(path)
      store.upsert(input('existing'))
      writeFileSync(path + '.config', 'Host imported\n HostName fixture.invalid\n User fixture\n')
      const first = child(path, 'pause', 'first'); jobs.push(first)
      await ready(path)
      const owner = readFileSync(path + '.lock', 'utf8')
      const second = child(path, mode, 'existing', 60); jobs.push(second)
      const result = await second.done
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('SSH_HOST_STORE_BUSY')
      expect(readFileSync(path + '.lock', 'utf8')).toBe(owner)
      writeFileSync(path + '.release', 'go')
      expect((await first.done).code).toBe(0)
      expect(store.list().map(entry => entry.alias).sort()).toEqual(['existing', 'first'])
    })
  })

  it.each(['remove', 'import'])('reloads the committed state before a successful contended %s', async mode => {
    await fixture(async (path, jobs) => {
      new HostStore(path).upsert(input('existing'))
      // Import must not overwrite an alias another process adds while it waits.
      writeFileSync(path + '.config', 'Host first\n HostName must-not-replace.invalid\n User other\nHost imported\n HostName imported.invalid\n User other\n')
      const first = child(path, 'pause', 'first'); jobs.push(first)
      await ready(path)
      const second = child(path, mode, 'existing'); jobs.push(second)
      await delay(100)
      writeFileSync(path + '.release', 'go')
      expect((await first.done).code).toBe(0)
      expect(await second.done).toEqual({ code: 0, stdout: 'success', stderr: '' })
      const store = new HostStore(path)
      expect(store.find('first')?.host).toBe('fixture.invalid')
      expect(store.list().map(entry => entry.alias).sort()).toEqual(mode === 'remove' ? ['first'] : ['existing', 'first', 'imported'])
      expect(existsSync(path + '.lock')).toBe(false)
    })
  })

  it('releases its owned lock when save fails so the next mutation succeeds', async () => {
    await fixture(async (path, jobs) => {
      const failed = child(path, 'fail'); jobs.push(failed)
      expect((await failed.done).stderr).toContain('fixture save failure')
      expect(existsSync(path + '.lock')).toBe(false)
      new HostStore(path).upsert(input('after-failure'))
      expect(new HostStore(path).list().map(entry => entry.alias)).toEqual(['after-failure'])
    })
  })

  it.each(['tamper', 'replace'])('rejects %s lock ownership and leaves foreign lock untouched', async mode => {
    await fixture(async (path, jobs) => {
      new HostStore(path).upsert(input('existing'))
      const job = child(path, mode); jobs.push(job)
      const result = await job.done
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('lock ownership changed')
      expect(readFileSync(path + '.lock', 'utf8')).toBe('foreign-owner')
      expect(new HostStore(path).list().map(entry => entry.alias)).toEqual(['existing'])
    })
  })

  it('keeps a crash orphan rather than trusting an old PID or timestamp', async () => {
    await fixture(async (path, jobs) => {
      const job = child(path, 'crash'); jobs.push(job)
      expect((await job.done).code).toBe(17)
      const orphan = readFileSync(path + '.lock', 'utf8')
      expect(JSON.parse(orphan)).toMatchObject({ pid: expect.any(Number), token: expect.any(String) })
      const store = new HostStore(path, undefined, { lockTimeoutMs: 10 })
      expect(() => store.upsert(input('next'))).toThrow(HostStoreBusyError)
      expect(readFileSync(path + '.lock', 'utf8')).toBe(orphan)
      expect(store.list()).toEqual([])
    })
  })
})
