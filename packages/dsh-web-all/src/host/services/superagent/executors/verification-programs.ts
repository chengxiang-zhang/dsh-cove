/** Fixed programs run in separate processes. None imports a candidate into a collector. */
export const PREPARE_PROGRAM = `
import { writeFileSync } from 'node:fs'
let text = ''
for await (const chunk of process.stdin) {
  text += chunk
  if (text.length > 1048576) throw Error('ASSETS_TOO_LARGE')
}
const { path, cases } = JSON.parse(text)
writeFileSync(path, JSON.stringify(cases), { flag: 'wx', mode: 0o400 })
process.stdout.write(JSON.stringify({ pid: process.pid }))
`

export const CANDIDATE_PROGRAM = `
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
const module = await import(pathToFileURL(process.argv[2]).href)
const call = module[process.argv[3]]
if (typeof call !== 'function') throw Error('CANDIDATE_EXPORT_REQUIRED')
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const frame = JSON.parse(line)
  const value = await call(frame.input)
  process.stdout.write(JSON.stringify({ id: frame.id, value }) + '\\n')
}
`

export const COLLECT_PROGRAM = `
import { spawn } from 'node:child_process'
import { readFileSync, lstatSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
let input = ''
for await (const chunk of process.stdin) {
  input += chunk
  if (input.length > 2097152) throw Error('REQUEST_TOO_LARGE')
}
const c = JSON.parse(input),
  hash = (b) => createHash('sha256').update(b).digest('hex')
const assets = readFileSync(c.assets),
  cases = JSON.parse(assets)
const intact = () => {
  if (hash(readFileSync(c.assets)) !== c.assetDigest) return false
  const found = []
  const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name),
        rel = prefix + name,
        s = lstatSync(path)
      if (s.isSymbolicLink()) throw Error('SYMLINK')
      if (s.isDirectory()) walk(path, rel + '/')
      else if (s.isFile()) found.push({ path: rel, digest: hash(readFileSync(path)) })
      else throw Error('SPECIAL_FILE')
    }
  }
  walk(c.root)
  return JSON.stringify(found) === JSON.stringify(c.manifest)
}
let integrity = false
try {
  integrity = intact()
} catch {}
if (!integrity) throw Error('SEALED_INPUT_CHANGED')
const external = c.launchPortModule ? await import(c.launchPortModule) : null
const child = external ? external.configuredSandboxLaunchPort().open({profile: external.sandboxFixtureProfile(c.profile), executable: c.executable, args: [c.wrapper, join(c.root,c.entry),c.exportName], cwd:c.scratch, env:{PATH:'/usr/bin:/bin',HOME:c.scratch,TMPDIR:c.scratch,LANG:'en_US.UTF-8'},processPolicy:'single',timeoutMs:c.timeoutMs}) : spawn(
  '/usr/bin/sandbox-exec',
  ['-p', c.profile, c.executable, c.wrapper, join(c.root, c.entry), c.exportName],
  {
    cwd: c.scratch,
    env: { PATH: '/usr/bin:/bin', HOME: c.scratch, TMPDIR: c.scratch, LANG: 'en_US.UTF-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true
  }
)
const stdoutChunks = [], stderrChunks = []
let outputBytes = 0
let stdout = '',
  stderr = '',
  complete = true,
  exit = null,
  finished = false,
  drain
const kill = () => {
  if (external) { child.cancel(); return }
  if (child.pid)
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
}
process.on('SIGTERM', () => {
  complete = false
  kill()
  drain ??= setTimeout(finish, 200)
})
const timer = setTimeout(() => {
  complete = false
  kill()
  drain ??= setTimeout(finish, 200)
}, c.timeoutMs)
const capture = (which, chunk) => {
  const remaining = Math.max(0, 1048576 - outputBytes)
  if (remaining) (which === 'stdout' ? stdoutChunks : stderrChunks).push(chunk.subarray(0, remaining))
  outputBytes += chunk.length
  if (outputBytes > 1048576) {
    complete = false
    kill()
    drain ??= setTimeout(finish, 200)
  }
}
child.stdout.on('data', (b) => capture('stdout', b))
child.stderr.on('data', (b) => capture('stderr', b))
child.stdin.on('error', () => {
  complete = false
})
child.on('error', () => {
  complete = false
  drain ??= setTimeout(finish, 200)
})
child.once('exit', (code) => {
  exit = code
  drain ??= setTimeout(finish, 200)
})
child.once('close', finish)
child.stdin.end(cases.map((v, id) => JSON.stringify({ id, input: v.input })).join('\\n') + '\\n')
function finish() {
  if (finished) return
  finished = true
  clearTimeout(timer)
  clearTimeout(drain)
  kill()
  child.stdin.destroy()
  child.stdout.destroy()
  child.stderr.destroy()
  child.unref()
  try {
    integrity = intact()
  } catch {
    integrity = false
  }
  const stdoutRaw = Buffer.concat(stdoutChunks), stderrRaw = Buffer.concat(stderrChunks)
  stdout = stdoutRaw.toString('utf8')
  stderr = stderrRaw.toString('utf8')
  try {
    new TextDecoder('utf-8', {fatal:true}).decode(stdoutRaw)
    new TextDecoder('utf-8', {fatal:true}).decode(stderrRaw)
  } catch { complete = false }
  let frames = []
  try {
    frames = stdout
      .trim()
      .split('\\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    complete = false
  }
  if (
    exit !== 0 ||
    frames.length !== cases.length ||
    frames.some(
      (v, i) =>
        !v ||
        v.id !== i ||
        !Object.hasOwn(v, 'value') ||
        Object.keys(v).some((k) => !['id', 'value'].includes(k))
    )
  )
    complete = false
  const results = cases.map((v, i) => ({
    criterion: v.criterion,
    verdict:
      !complete || !integrity
        ? 'inconclusive'
        : isDeepStrictEqual(frames[i].value, v.expected)
          ? 'pass'
          : 'fail',
    reason:
      !complete || !integrity
        ? 'Missing exit/data or sealed integrity failed'
        : isDeepStrictEqual(frames[i].value, v.expected)
          ? 'Observed return matches frozen expectation'
          : 'Observed return differs from frozen expectation'
  }))
  process.stdout.write(
    JSON.stringify({
      run_id: c.runId,
      collector_pid: process.pid,
      candidate_pid: child.pid ?? null,
      exit_code: exit,
      stdout,
      stderr,
      stdout_base64: stdoutRaw.toString('base64'),
      stderr_base64: stderrRaw.toString('base64'),
      complete,
      integrity,
      results
    })
  )
}
`
