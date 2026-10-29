import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The launcher is the only artifact that carries the loopback listener and the
// --trusted-host authorities into the boot-time LaunchDaemon, so these tests
// pin the template, the shell helper library the installer uses to write it,
// and the plist that starts it.
const libPath = fileURLToPath(new URL('../tools/dsh-launchd/lib-dsh-launchd.sh', import.meta.url))
const templatePath = fileURLToPath(new URL('../tools/dsh-launchd/launchd/start-dsh-web.sh', import.meta.url))
const plistPath = fileURLToPath(new URL('../tools/dsh-launchd/launchd/ai.deepseek.dsh.web.plist', import.meta.url))
const installerPath = fileURLToPath(new URL('../tools/dsh-launchd/install-dsh-daemons.sh', import.meta.url))
const machinesPath = fileURLToPath(new URL('../tools/dsh-netbird/machines.json', import.meta.url))

const workDir = await mkdtemp(join(tmpdir(), 'dsh-launchd-test-'))
after(() => rm(workDir, { recursive: true, force: true }))

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

// Run a library function under /bin/sh with the library sourced; the library is
// POSIX sh so the same functions the zsh entry point sources are exercised here.
function shell(body) {
  return execFileSync('/bin/sh', ['-c', `. "$1"\n${body}`, 'sh', libPath], { encoding: 'utf8' })
}

function shellResult(body) {
  try {
    return { status: 0, stdout: shell(body), stderr: '' }
  } catch (error) {
    return { status: error.status ?? 1, stdout: `${error.stdout ?? ''}`, stderr: `${error.stderr ?? ''}` }
  }
}

test('launcher template pins the loopback listener and the trusted-host placeholder', async () => {
  const template = await readFile(templatePath, 'utf8')
  assert.match(template, /^#!\/bin\/bash$/m)
  assert.match(template, /--trusted-host/)
  assert.match(template, /^exec __DSH_BIN_DIR__\/dsh web --host 127\.0\.0\.1 --port 3080 --no-open __TRUSTED_HOST_FLAGS__$/m)
})

test('launcher template exports HOME, DSH_HOME and PATH from placeholders', async () => {
  const template = await readFile(templatePath, 'utf8')
  assert.match(template, /^export HOME="__HOME__"$/m)
  assert.match(template, /^export DSH_HOME="__DSH_HOME__"$/m)
  assert.match(template, /^export PATH="__DSH_BIN_DIR__:/m)
})

test('launcher template stays headless: no prompts, no privilege escalation, no discovery', async () => {
  const template = await readFile(templatePath, 'utf8')
  assert.doesNotMatch(template, /\bread\s+-[rp]?\b/)
  assert.doesNotMatch(template, /\bsudo\b/)
  assert.doesNotMatch(template, /^\s*(hostname|scutil|networksetup|ifconfig|ipconfig)\b/m)
})

test('launcher template placeholders match the set the installer substitutes', async () => {
  const template = await readFile(templatePath, 'utf8')
  const tokens = [...new Set(template.match(/__[A-Z][A-Z_]*__/g) ?? [])].sort()
  assert.deepEqual(tokens, ['__DSH_BIN_DIR__', '__DSH_HOME__', '__HOME__', '__TRUSTED_HOST_FLAGS__'])
  const declared = shell('printf "%s\\n" "$DSH_LAUNCHD_TEMPLATE_PLACEHOLDERS"').trim().split(/\s+/).sort()
  assert.deepEqual(declared, tokens)
})

test('renderer bakes one --trusted-host flag per authority and leaves no placeholder behind', () => {
  const rendered = shell([
    'dsh_launchd_render_launcher',
    quote(templatePath),
    quote('/opt/node/bin'),
    quote('/Users/tester'),
    quote('/Users/tester/.dsh'),
    quote('dsh.laptop-b\ndsh.imac-office'),
  ].join(' '))
  const execLine = rendered.split('\n').find((line) => line.startsWith('exec '))
  assert.equal(execLine, 'exec /opt/node/bin/dsh web --host 127.0.0.1 --port 3080 --no-open --trusted-host dsh.laptop-b --trusted-host dsh.imac-office')
  assert.equal((execLine.match(/--trusted-host/g) ?? []).length, 2)
  assert.equal(rendered.includes('__'), false)
  assert.match(rendered, /^export HOME="\/Users\/tester"$/m)
  assert.match(rendered, /^export DSH_HOME="\/Users\/tester\/\.dsh"$/m)
})

test('renderer refuses to render without an authority', () => {
  const result = shellResult([
    'dsh_launchd_render_launcher',
    quote(templatePath),
    quote('/opt/node/bin'),
    quote('/Users/tester'),
    quote('/Users/tester/.dsh'),
    quote(''),
  ].join(' '))
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /trusted authority/)
})

test('renderer refuses a file that is not a launcher template', () => {
  const result = shellResult(`dsh_launchd_render_launcher ${quote(installerPath)} /opt/node/bin /Users/tester /Users/tester/.dsh dsh.laptop-b`)
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /not a launcher template/)
})

test('authority validation accepts canonical DNS names and rejects everything else', () => {
  const accepted = ['dsh.laptop-b', 'dsh.studio-mac', 'dsh.thinkcentre-lab']
  const rejected = ['', 'localhost', '100.64.0.12', 'dsh.laptop-b:3080', 'http://dsh.laptop-b', '-dsh.laptop-b', 'dsh.laptop-b.', 'dsh..laptop-b', 'a_b.c', 'DSH.ZCX MBP']
  for (const authority of accepted) {
    const result = shellResult(`dsh_launchd_authority_is_valid ${quote(authority)}`)
    assert.equal(result.status, 0, `expected ${authority} to be accepted`)
  }
  for (const authority of rejected) {
    const result = shellResult(`dsh_launchd_authority_is_valid ${quote(authority)}`)
    assert.notEqual(result.status, 0, `expected ${authority} to be rejected`)
  }
})

test('authority collection resolves --machine through machines.json and dedupes in order', () => {
  const collected = shell([
    'dsh_launchd_authorities',
    quote(machinesPath),
    quote('dsh.imac-office.netbird'),
    quote('laptop-b\nimac-office'),
  ].join(' '))
  assert.deepEqual(collected.trim().split('\n'), ['dsh.imac-office.netbird', 'dsh.laptop-b.netbird'])
  const domains = shell(`dsh_launchd_machine_domain ${quote(machinesPath)} laptop-b`)
  assert.equal(domains.trim(), 'dsh.laptop-b.netbird')
})

test('authority collection fails closed without an authority', () => {
  const result = shellResult(`dsh_launchd_authorities ${quote(machinesPath)} '' ''`)
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /no trusted authority given/)
})

test('authority collection fails closed on an unknown machine or a non-canonical host', () => {
  for (const [hosts, machines, expected] of [
    ['', 'no-such-machine', /unknown netbird machine/],
    ['100.64.0.12', '', /not a canonical authority/],
  ]) {
    const result = shellResult(`dsh_launchd_authorities ${quote(machinesPath)} ${quote(hosts)} ${quote(machines)}`)
    assert.notEqual(result.status, 0, `expected failure for hosts=${hosts} machines=${machines}`)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, expected)
  }
})

test('a --trusted-host mention inside a comment does not count as a configured authority', async () => {
  const commented = join(workDir, 'commented.sh')
  await writeFile(commented, '#!/bin/bash\n# passes --trusted-host once configured\nexec dsh web --no-open\n')
  const noFlag = shellResult(`dsh_launchd_launcher_has_trusted_host ${quote(commented)}`)
  assert.notEqual(noFlag.status, 0)
  assert.equal(noFlag.stdout, '')
  assert.equal(shell(`dsh_launchd_launcher_decision ${quote(commented)} 0`).trim(), 'write')
})

test('launcher decision keeps a configured launcher unless a rewrite is requested', async () => {
  const configured = join(workDir, 'configured.sh')
  await writeFile(configured, '#!/bin/bash\nexec dsh web --no-open --trusted-host dsh.laptop-b\n')
  assert.equal(shell(`dsh_launchd_launcher_decision ${quote(configured)} 0`).trim(), 'keep')
  assert.equal(shell(`dsh_launchd_launcher_decision ${quote(configured)} 1`).trim(), 'write')
  assert.equal(shell(`dsh_launchd_launcher_decision ${quote(join(workDir, 'missing.sh'))} 0`).trim(), 'write')
})

test('plist ProgramArguments still point at $DSH_HOME/bin/start-dsh-web.sh', async () => {
  const plist = await readFile(plistPath, 'utf8')
  const array = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)
  assert.ok(array, 'plist must declare ProgramArguments')
  const args = [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => match[1])
  assert.equal(args.length, 1)
  assert.match(args[0], /\/\.dsh\/bin\/start-dsh-web\.sh$/)
})

test('daemon plist PATH names the directory the installer resolves dsh from', async () => {
  const plist = await readFile(plistPath, 'utf8')
  const declared = plist.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/)
  assert.ok(declared, 'plist must declare EnvironmentVariables PATH')
  const first = declared[1].split(':')[0]
  assert.match(first, /\/bin$/)
  assert.equal(shell(`dsh_launchd_plist_first_path_dir ${quote(plistPath)}`).trim(), first)
})

test('installer refuses to proceed without an authority before it touches the daemons', async () => {
  const installer = await readFile(installerPath, 'utf8')
  const resolve = installer.indexOf('dsh_launchd_authorities')
  assert.ok(resolve > -1, 'installer must resolve authorities through the shared helper')
  assert.match(installer, /if ! AUTHORITY_LIST=\$\(dsh_launchd_authorities[\s\S]*?\); then\n\s*die /)
  assert.match(installer, /LAUNCHER=\$DSH_HOME_DIR\/bin\/start-dsh-web\.sh/)
  assert.match(installer, /\.bak-\$\(date \+%Y%m%d-%H%M%S\)/)
  assert.match(installer, /--rewrite-launcher/)
  assert.match(installer, /find_in start-dsh-web\.sh/)
  for (const later of [
    'install -o "$TARGET_USER"',
    'launchctl bootout "gui/$TARGET_UID/$label"',
    'install -o root -g wheel',
    'launchctl bootstrap system',
  ]) {
    assert.ok(installer.indexOf(later) > resolve, `authority resolution must run before: ${later}`)
  }
})

test('daemon plists are templates without machine-specific paths', async () => {
  for (const name of ['ai.deepseek.dsh.web.plist', 'com.leo.dsh-nginx.plist', 'com.zcx.dsh-api-proxy.plist']) {
    const text = await readFile(fileURLToPath(new URL(`../tools/dsh-launchd/launchd/${name}`, import.meta.url)), 'utf8')
    assert.doesNotMatch(text, /\/Users\//, name + ' must not hardcode a home directory')
    assert.match(text, /__HOME__/, name + ' must declare the __HOME__ placeholder')
  }
})
