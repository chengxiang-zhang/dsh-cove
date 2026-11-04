#!/usr/bin/env node
/**
 * Claim verifier: turn an external agent's citations into a mechanical verdict.
 *
 * Why this exists. A dispatched strong agent returns prose in which every
 * citation is equally confident, and the person who has to decide then reads
 * all of them again by hand. That cost lands on the Lead's context and, worse,
 * makes the copier the grader. This script moves the grading off both of them:
 * the agent writes one machine-readable line per claim, and this walks the
 * lines against the working tree.
 *
 * Two claim kinds, because two kinds cover every citation we actually make:
 *
 *   file-line  a path and line (or range) plus the text that must appear there.
 *   command    an argv the agent claims was run, plus the exit code it claims.
 *              "must be absent" is this kind with expectExit: 1 (grep found
 *              nothing), not a third kind.
 *
 * Verdicts are the preset's existing two states, so nothing new is invented:
 * verified (已证实) or unverified (未证实). There is no "probably".
 *
 * Cited prose wraps. A range match therefore compares normalized text (comment
 * decoration stripped, lines joined, whitespace collapsed), because "the file
 * says X on lines 19-22" is a claim about the sentence, not about where the
 * terminal broke the line. Joining preserves order, so the normalization cannot
 * make a phrase match lines that are not adjacent in the file.
 *
 * Usage:
 *   node verify-claims.mjs --claims <file.jsonl> [--root <dir>] [--report <out.md>]
 *   node verify-claims.mjs --selftest
 *
 * Claim format (JSONL, one object per line; this header is the single source):
 *
 *   {"id":"c1","kind":"file-line","target":"src/x.ts:19-22","expect":"原文片段"}
 *   {"id":"c2","kind":"file-line","target":"src/x.ts:51","expectAbsent":"TODO"}
 *   {"id":"c3","kind":"command","argv":["grep","-rn",".prompt(","src"],"expectExit":1}
 *   {"id":"c4","kind":"command","argv":["node","-e","…"],"expectStdout":"ok"}
 *
 * expectExit defaults to 0, so a "must be absent" citation is a `command` with
 * expectExit: 1 and no extra kind. `target` may cite one line or a range.
 *
 * Exit: 0 every claim verified; 1 at least one unverified; 2 usage or IO error.
 *
 * Honest limits. The denylist below stops a claim list from deleting or
 * pushing by accident. It is not a sandbox: `node -e`, an interpreter, or any
 * binary not on the list can still do real work. Claims come from an agent we
 * chose to run with write permission, so this guards mistakes, not malice.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Verdict vocabulary. Exactly the two states the preset already uses. */
export const VERIFIED = 'verified'
export const UNVERIFIED = 'unverified'

/** First argv token that makes a claim list dangerous to run unattended. */
const DENY_BINARIES = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'dd', 'chmod', 'chown', 'chgrp', 'mkfs',
  'shutdown', 'reboot', 'halt', 'kill', 'pkill', 'killall', 'sudo', 'su', 'doas',
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'tee', 'truncate',
])

/** `git` subcommands that change a repository instead of reading it. */
const DENY_GIT = new Set([
  'push', 'reset', 'checkout', 'switch', 'restore', 'clean', 'commit',
  'rebase', 'merge', 'rm', 'mv', 'stash', 'tag', 'filter-branch', 'gc', 'prune',
])

const COMMAND_TIMEOUT_MS = 20000

/**
 * Read claims from JSONL text.
 * @param text - File body, one JSON object per non-empty line.
 * @returns Parsed claims in file order.
 */
export function parseClaims(text) {
  const claims = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '') continue
    let value
    try {
      value = JSON.parse(line)
    } catch (error) {
      throw new Error(`line ${index + 1}: not JSON (${error.message})`)
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`line ${index + 1}: claim must be an object`)
    }
    const id = typeof value.id === 'string' ? value.id.trim() : ''
    if (id === '') throw new Error(`line ${index + 1}: missing id`)
    if (value.kind !== 'file-line' && value.kind !== 'command') {
      throw new Error(`line ${index + 1}: kind must be file-line or command`)
    }
    claims.push({ ...value, id })
  }
  return claims
}

/**
 * Resolve a claim path against the root, refusing to leave it.
 * @param root - Directory the claims were authored against.
 * @param target - Path as written in the claim.
 * @param allowOutside - Whether an absolute path outside root is permitted.
 * @returns Absolute path.
 */
function resolveInside(root, target, allowOutside) {
  const absolute = resolve(root, target)
  if (allowOutside) return absolute
  const prefix = resolve(root) + sep
  if (absolute !== resolve(root) && !absolute.startsWith(prefix)) {
    throw new Error(`path escapes the claim root: ${target}`)
  }
  return absolute
}

/**
 * Collapse a cited range to the text a human reads: comment decorations gone,
 * line wrapping gone, runs of spaces collapsed.
 *
 * This matters because prose citations wrap. A claim that the file "says X at
 * 19-22" is about the sentence, not about where the terminal broke the line, so
 * matching the raw slice would reject a correct citation whose expected phrase
 * happens to straddle two lines. Joining preserves order, so this cannot make a
 * distant phrase match one that is not actually adjacent in the file.
 * @param text - Raw slice of the cited lines.
 * @returns Normalized text for substring matching.
 */
export function normalizeForMatch(text) {
  return text
    .split('\n')
    .map(line => line.replace(/^\s*(?:\*|\/\/|#)\s?/u, ''))
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Verify one `file-line` claim: the cited lines must contain the expected text.
 * @param claim - Parsed claim.
 * @param root - Claim root directory.
 * @param allowOutside - Whether paths outside root are permitted.
 * @returns Verdict with a reason when unverified.
 */
export function verifyFileLine(claim, root, allowOutside = false) {
  const target = typeof claim.target === 'string' ? claim.target.trim() : ''
  const match = /^(.*):(\d+)(?:-(\d+))?$/u.exec(target)
  if (target === '' || match === null) return fail('target must be <path>:<line> or <path>:<line>-<line>')
  const [, path, rawStart, rawEnd] = match
  const start = Number(rawStart)
  const end = rawEnd === undefined ? start : Number(rawEnd)
  if (start < 1 || end < start) return fail('target line range is not a positive ascending range')

  let absolute
  try {
    absolute = resolveInside(root, path, allowOutside)
  } catch (error) {
    return fail(error.message)
  }
  if (!existsSync(absolute)) return fail(`file not found: ${path}`)
  if (!statSync(absolute).isFile()) return fail(`not a file: ${path}`)

  const lines = readFileSync(absolute, 'utf8').split('\n')
  if (end > lines.length) return fail(`${path} has ${lines.length} lines, claim cites up to ${end}`)

  const body = normalizeForMatch(lines.slice(start - 1, end).join('\n'))
  const expect = typeof claim.expect === 'string' ? claim.expect : undefined
  if (expect !== undefined && !body.includes(normalizeForMatch(expect))) {
    return fail(`line ${start}-${end} of ${path} does not contain ${JSON.stringify(expect)}`)
  }
  const expectAbsent = typeof claim.expectAbsent === 'string' ? claim.expectAbsent : undefined
  if (expectAbsent !== undefined && body.includes(normalizeForMatch(expectAbsent))) {
    return fail(`line ${start}-${end} of ${path} unexpectedly contains ${JSON.stringify(expectAbsent)}`)
  }
  if (expect === undefined && expectAbsent === undefined) {
    return fail('claim asserts nothing: give expect or expectAbsent')
  }
  return { status: VERIFIED, detail: `${path}:${start}-${end}` }
}

/**
 * Verify one `command` claim: re-run the argv and compare the exit code.
 * @param claim - Parsed claim.
 * @param root - Working directory for the command.
 * @returns Verdict with a reason when unverified.
 */
export function verifyCommand(claim, root) {
  const argv = Array.isArray(claim.argv) ? claim.argv.filter(part => typeof part === 'string') : []
  if (argv.length === 0) return fail('argv must be a non-empty array of strings')

  const binary = basename(argv[0])
  if (DENY_BINARIES.has(binary)) return fail(`refusing to run ${binary} from a claim list`)
  if (binary === 'git' && DENY_GIT.has((argv[1] ?? '').trim())) {
    return fail(`refusing to run git ${argv[1]} from a claim list`)
  }

  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: root,
    shell: false,
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error !== undefined && result.error !== null) return fail(`spawn failed: ${result.error.message}`)
  if (result.signal !== null) return fail(`command killed by ${result.signal} (timeout ${COMMAND_TIMEOUT_MS}ms)`)

  const expectExit = typeof claim.expectExit === 'number' ? claim.expectExit : 0
  if (result.status !== expectExit) {
    return fail(`exit ${result.status}, claim expects ${expectExit}`)
  }
  const stdout = result.stdout ?? ''
  if (typeof claim.expectStdout === 'string' && !stdout.includes(claim.expectStdout)) {
    return fail(`stdout does not contain ${JSON.stringify(claim.expectStdout)}`)
  }
  if (claim.expectStdoutEmpty === true && stdout.trim() !== '') {
    return fail('stdout must be empty but was not')
  }
  return { status: VERIFIED, detail: `exit ${result.status}` }
}

/** Build an unverified verdict carrying its reason. */
function fail(reason) {
  return { status: UNVERIFIED, detail: reason }
}

/**
 * Verify every claim and keep the input order.
 * @param claims - Parsed claims.
 * @param root - Claim root directory.
 * @param allowOutside - Whether paths outside root are permitted.
 * @returns One result per claim.
 */
export function verifyAll(claims, root, allowOutside = false) {
  return claims.map(claim => ({
    claim,
    ...(claim.kind === 'file-line'
      ? verifyFileLine(claim, root, allowOutside)
      : verifyCommand(claim, root)),
  }))
}

/**
 * Render the unverified claims as the block a Lead pastes into the artifact,
 * so the artifact says 未证实 in the agent's own numbering instead of a
 * hand-written guess about which citations were actually reproduced.
 * @param results - Output of verifyAll.
 * @returns Markdown, empty when everything verified.
 */
export function renderReport(results) {
  const bad = results.filter(result => result.status === UNVERIFIED)
  if (bad.length === 0) return ''
  const rows = bad.map(result => {
    const target = result.claim.kind === 'file-line'
      ? String(result.claim.target ?? '')
      : Array.isArray(result.claim.argv) ? result.claim.argv.join(' ') : ''
    return `| \`${result.claim.id}\` | ${result.claim.kind} | \`${target}\` | ${result.detail} |`
  })
  return [
    '## 未证实（本机复跑判定）',
    '',
    `共 ${results.length} 条断言，${bad.length} 条未通过本机复跑。以下各条只能进"未证实"，不得当结论：`,
    '',
    '| claim | 类型 | 引用 | 本机判定 |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n')
}

/** Print usage to stderr and exit 2. */
function usage(message) {
  process.stderr.write(`${message}\n`)
  process.stderr.write(
    'usage: node verify-claims.mjs --claims <file.jsonl> [--root <dir>] [--report <out.md>] [--allow-outside]\n' +
    '       node verify-claims.mjs --selftest\n',
  )
  process.exit(2)
}

/**
 * Self-test: positive and negative cases for both kinds. The negative cases
 * are the point - a grader that cannot fail proves nothing.
 * @returns 0 when every case behaves, 1 otherwise.
 */
function selftest() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-claims-'))
  const cases = []
  const run = (label, body, expected) => {
    let actual
    try {
      actual = body()
    } catch (error) {
      actual = `threw: ${error.message}`
    }
    cases.push({ label, actual, expected })
  }
  try {
    writeFileSync(join(dir, 'fixture.ts'), 'alpha\nbeta gateEvent gamma\ndelta\n')
    writeFileSync(join(dir, 'short.ts'), 'only\n')
    writeFileSync(join(dir, 'wrapped.ts'), '/**\n * alpha beta\n *   gamma delta epsilon\n */\n')
    writeFileSync(join(dir, 'distant.ts'), 'alpha\nbeta\ndelta\n')

    run('file-line hit', () => verifyFileLine(
      { kind: 'file-line', target: 'fixture.ts:2', expect: 'gateEvent' }, dir).status, VERIFIED)
    run('phrase across a wrapped comment binds', () => verifyFileLine(
      { kind: 'file-line', target: 'wrapped.ts:2-3', expect: 'beta gamma delta' }, dir).status, VERIFIED)
    run('distant lines do not bind', () => verifyFileLine(
      { kind: 'file-line', target: 'distant.ts:1-3', expect: 'alpha delta' }, dir).status, UNVERIFIED)
    run('range hit', () => verifyFileLine(
      { kind: 'file-line', target: 'fixture.ts:1-3', expect: 'delta' }, dir).status, VERIFIED)
    run('absent holds', () => verifyFileLine(
      { kind: 'file-line', target: 'fixture.ts:1-3', expectAbsent: 'nothing-here' }, dir).status, VERIFIED)
    run('missing text misses', () => verifyFileLine(
      { kind: 'file-line', target: 'fixture.ts:1', expect: 'gateEvent' }, dir).status, UNVERIFIED)
    run('past end misses', () => verifyFileLine(
      { kind: 'file-line', target: 'short.ts:9', expect: 'only' }, dir).status, UNVERIFIED)
    run('escape blocked', () => verifyFileLine(
      { kind: 'file-line', target: '../../etc/hosts:1', expect: 'x' }, dir).status, UNVERIFIED)
    run('no assertion misses', () => verifyFileLine(
      { kind: 'file-line', target: 'fixture.ts:1' }, dir).status, UNVERIFIED)

    run('command exit 0', () => verifyCommand({ kind: 'command', argv: ['true'] }, dir).status, VERIFIED)
    run('command exit 1 as claimed', () => verifyCommand(
      { kind: 'command', argv: ['false'], expectExit: 1 }, dir).status, VERIFIED)
    run('wrong exit misses', () => verifyCommand({ kind: 'command', argv: ['false'] }, dir).status, UNVERIFIED)
    run('denylist blocks rm', () => verifyCommand(
      { kind: 'command', argv: ['rm', '-rf', 'fixture.ts'] }, dir).status, UNVERIFIED)
    run('denylist blocks git push', () => verifyCommand(
      { kind: 'command', argv: ['git', 'push'] }, dir).status, UNVERIFIED)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  let failed = 0
  for (const item of cases) {
    const ok = item.actual === item.expected
    if (!ok) failed += 1
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${item.label} (${item.actual})\n`)
  }
  process.stdout.write(`\n${cases.length - failed}/${cases.length} cases passed\n`)
  return failed === 0 ? 0 : 1
}

/** CLI entry. */
function main(argv) {
  const args = argv.slice(2)
  if (args.includes('--selftest')) process.exit(selftest())

  const read = (flag) => {
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }
  const claimsPath = read('--claims')
  if (claimsPath === undefined) usage('missing --claims')
  const root = resolve(read('--root') ?? process.cwd())
  const reportPath = read('--report')
  const allowOutside = args.includes('--allow-outside')

  let claims
  try {
    claims = parseClaims(readFileSync(claimsPath, 'utf8'))
  } catch (error) {
    usage(`cannot read claims: ${error.message}`)
  }
  if (claims.length === 0) usage('claim list is empty')

  const results = verifyAll(claims, root, allowOutside)
  const bad = results.filter(result => result.status === UNVERIFIED)
  for (const result of results) {
    process.stdout.write(`${result.status === VERIFIED ? 'verified  ' : 'UNVERIFIED'}  ${result.claim.id}  ${result.detail}\n`)
  }
  process.stdout.write(`\n${results.length - bad.length}/${results.length} verified, ${bad.length} unverified\n`)

  const report = renderReport(results)
  if (reportPath !== undefined && report !== '') writeFileSync(resolve(root, reportPath), report)
  process.exit(bad.length === 0 ? 0 : 1)
}

// Only run when invoked as a CLI, so importing the exports stays side-effect free.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv)
}