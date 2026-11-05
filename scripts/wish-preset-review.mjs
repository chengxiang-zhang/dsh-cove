#!/usr/bin/env node
/**
 * Wish-preset self-review: incrementally extract `code-vibe` sessions from the
 * fleet, compute the deterministic discipline readings, and write a Markdown
 * brief for the improvement loop.
 *
 * This script is the mechanical half of the loop. It never edits the preset and
 * never publishes anything: it answers "which sessions are new or changed since
 * the last run, and what do their readings look like". The judgement half lives
 * in the `preset-self-review` skill, and the distribution half stays behind the
 * repository's release and rollout gates.
 *
 * Reads only: remote machines run `cat` (to place the analyzer), `python3`
 * (to stream `zstd -dc` and count), and nothing else. Every candidate session is
 * filtered to top-level `code-vibe` sessions — subagent transcripts are evidence
 * of a worker's behaviour, not of the user-facing preset.
 *
 * State is incremental: `.harvest/wish-preset-review/state.json` remembers every
 * session id it has seen (gitignored, like every other harvest artifact). A run
 * reports new and changed sessions only; `--all` re-reads the whole window.
 *
 * Usage:
 *   node scripts/wish-preset-review.mjs                 # last 7 days, incremental
 *   node scripts/wish-preset-review.mjs --days 3
 *   node scripts/wish-preset-review.mjs --hosts pc-tower,zcx-t470p
 *   node scripts/wish-preset-review.mjs --all           # ignore the state cursor
 *   node scripts/wish-preset-review.mjs --json          # machine-readable summary
 *   node scripts/wish-preset-review.mjs --excerpt pc-tower:/home/pc/.dsh/sessions/...
 *
 * Exit: 0 ok (even with no new sessions), 1 at least one machine failed, 2 usage.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadScope } from './dsh-fleet-collect.mjs'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const STATE_VERSION = 1
export const DEFAULT_STATE_PATH = join(repoRoot, '.harvest', 'wish-preset-review', 'state.json')
export const DEFAULT_OUT_ROOT = join(repoRoot, '.harvest', 'wish-preset-review')
export const ANALYZER_REMOTE_PATH = '/tmp/dsh-wish-preset-review.py'

/** Denial texts a policy layer has put in front of the model, keyed by cause. */
export const DENIAL_LABELS = [
  ['destructive', '破坏性命令'],
  ['production', '涉及生产/不可逆'],
  ['commit-gate', '提交门'],
  ['missing-user', '只有用户能给'],
  ['needless-ask', '不需要用户'],
  ['one-ask', '只允许一次确认'],
  ['skill-route', '先加载对应 skill'],
  ['worktree', 'worktree 只能通过'],
  ['design-freeze', '冻结门'],
]

/** User wording that marks a round as a correction instead of a request. */
export const RAGE_WORDS = ['垃圾', '他妈', '傻逼', '停下', '到底在干什么', '空转', '作弊']

/**
 * The remote analyzer. It runs where `zstd` and the sessions live, streams each
 * transcript through `zstd -dc`, and prints one compact JSON object per session
 * so the operator Mac never downloads a multi-hundred-megabyte log.
 */
export const ANALYZER_SOURCE = `import argparse, json, os, shutil, subprocess, sys

DENY = ${JSON.stringify(DENIAL_LABELS)}
RAGE_WORDS = ${JSON.stringify(RAGE_WORDS)}


def text_of(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    out = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            out.append(block.get("text") or "")
    return "".join(out)


def analyze(path, mtime, size, zstd):
    header = None
    turns = []
    cur = None
    tool_calls = asks = errors = rage = users = 0
    denials = {}
    rage_samples = []
    first_user = ""
    last_final = ""
    started = last_at = None
    proc = subprocess.Popen([zstd, "-dc", path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    for raw in proc.stdout:
        try:
            d = json.loads(raw)
        except Exception:
            continue
        kind = d.get("type")
        tm = d.get("time")
        data = d.get("data") or {}
        if kind == "session":
            header = d
            started = d.get("createdAt")
        if tm:
            last_at = tm
        if kind == "turn/start":
            cur = {"start": tm, "end": None, "tools": 0, "assistant": ""}
            turns.append(cur)
        elif kind == "turn/end" and cur is not None:
            cur["end"] = tm
        elif kind == "user/message" and cur is not None:
            if (data.get("source") or {}).get("kind") == "user":
                txt = text_of(data.get("content"))
                users += 1
                if not first_user and txt.strip():
                    first_user = txt.strip()[:240]
                if any(w in txt for w in RAGE_WORDS):
                    rage += 1
                    if len(rage_samples) < 3:
                        rage_samples.append(txt.strip()[:140])
        elif kind == "assistant/message" and cur is not None:
            blocks = ((data.get("message") or {}).get("content")) or []
            txt = text_of(blocks)
            if txt.strip():
                cur["assistant"] = (cur["assistant"] + "\\n" + txt)[-600:]
                last_final = txt.strip()[:400]
        elif kind == "tool/call" and cur is not None:
            tool_calls += 1
            cur["tools"] += 1
            if data.get("name") == "ask_user_question":
                asks += 1
        elif kind == "tool/result":
            msg = data.get("message") or {}
            if msg.get("isError"):
                errors += 1
                txt = text_of(msg.get("content"))
                for label, needle in DENY:
                    if needle in txt:
                        denials[label] = denials.get(label, 0) + 1
    proc.wait()
    if header is None:
        return None
    top = not header.get("parentSession") and not header.get("origin")
    durations = []
    empty_turns = 0
    long_turns = 0
    for turn in turns:
        if not turn.get("end") or not turn.get("start"):
            continue
        seconds = (turn["end"] - turn["start"]) / 1000.0
        durations.append(seconds)
        if seconds > 600:
            long_turns += 1
        if turn["tools"] == 0 and not turn["assistant"]:
            empty_turns += 1
    return {
        "sessionId": header.get("id") or os.path.basename(os.path.dirname(path)),
        "cwd": header.get("cwd"),
        "preset": header.get("agentPreset") or "-",
        "topLevel": top,
        "startedAt": started,
        "updatedAt": last_at or int(mtime * 1000),
        "file": path,
        "bytes": size,
        "turns": len(turns),
        "toolCalls": tool_calls,
        "asks": asks,
        "errors": errors,
        "denials": denials,
        "rage": rage,
        "rageSamples": rage_samples,
        "users": users,
        "firstUser": first_user,
        "lastFinal": last_final,
        "maxTurnSec": int(max(durations)) if durations else 0,
        "longTurns": long_turns,
        "emptyTurns": empty_turns,
    }


def excerpt(path, zstd):
    proc = subprocess.Popen([zstd, "-dc", path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    turn = 0
    rows = []
    for raw in proc.stdout:
        try:
            d = json.loads(raw)
        except Exception:
            continue
        kind = d.get("type")
        data = d.get("data") or {}
        if kind == "turn/start":
            turn += 1
        elif kind == "user/message" and (data.get("source") or {}).get("kind") == "user":
            txt = text_of(data.get("content")).strip()
            if txt:
                rows.append({"turn": turn, "role": "user", "text": txt[:400]})
        elif kind == "assistant/message":
            txt = text_of(((data.get("message") or {}).get("content")) or []).strip()
            if txt:
                rows.append({"turn": turn, "role": "assistant", "text": txt[:500]})
    proc.wait()
    print(json.dumps({"path": path, "rows": rows[:240]}, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="")
    ap.add_argument("--since", type=float, default=0.0)
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--preset", default="code-vibe")
    ap.add_argument("--excerpt", default="")
    ap.add_argument("--exclude", default="")
    args = ap.parse_args()
    zstd = shutil.which("zstd") or "/usr/bin/zstd"
    args.root = os.path.expanduser(args.root)
    if args.excerpt:
        excerpt(args.excerpt, zstd)
        return
    excluded = [x for x in args.exclude.split(",") if x]
    files = []
    for dirpath, _dirnames, filenames in os.walk(args.root):
        for name in filenames:
            if not (name.startswith("session") and name.endswith(".jsonl.zstd")):
                continue
            path = os.path.join(dirpath, name)
            try:
                stat = os.stat(path)
            except OSError:
                continue
            if path in excluded or stat.st_mtime < args.since:
                continue
            files.append((stat.st_mtime, stat.st_size, path))
    files.sort(reverse=True)
    printed = 0
    for mtime, size, path in files:
        if printed >= args.limit:
            break
        try:
            record = analyze(path, mtime, size, zstd)
        except Exception:
            continue
        if record is None or record["preset"] != args.preset or not record["topLevel"]:
            continue
        print(json.dumps(record, ensure_ascii=False))
        printed += 1


if __name__ == "__main__":
    main()
`

export function parseArgs(argv) {
  const options = {
    days: 7,
    hosts: null,
    limit: 200,
    all: false,
    json: false,
    quiet: false,
    state: DEFAULT_STATE_PATH,
    out: DEFAULT_OUT_ROOT,
    excerpt: null,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      if (argv[i + 1] === undefined) throw new Error(`missing value for ${arg}`)
      i += 1
      return argv[i]
    }
    switch (arg) {
      case '--days':
        options.days = Number(next())
        break
      case '--hosts':
        options.hosts = next().split(',').map((name) => name.trim()).filter(Boolean)
        break
      case '--limit':
        options.limit = Number(next())
        break
      case '--all':
        options.all = true
        break
      case '--json':
        options.json = true
        break
      case '--quiet':
        options.quiet = true
        break
      case '--state':
        options.state = resolve(next())
        break
      case '--out':
        options.out = resolve(next())
        break
      case '--excerpt':
        options.excerpt = next()
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown argument ${arg}`)
    }
  }
  if (!Number.isFinite(options.days) || options.days <= 0) throw new Error('--days must be a positive number')
  if (!Number.isInteger(options.limit) || options.limit <= 0) throw new Error('--limit must be a positive integer')
  return options
}

/** Parses the analyzer's JSONL stream; malformed lines are dropped, not fatal. */
export function parseAnalyzerOutput(stdout, host = 'unknown') {
  const rows = []
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!record || typeof record !== 'object' || !record.sessionId) continue
    rows.push({ ...record, host })
  }
  return rows
}

/** Reads the state file; a missing or unreadable state starts from empty. */
export function readState(path = DEFAULT_STATE_PATH) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (raw && raw.version === STATE_VERSION && raw.hosts && typeof raw.hosts === 'object') return raw
  } catch {
    // fall through to a fresh state
  }
  return { version: STATE_VERSION, hosts: {}, runs: [] }
}

/** A session is new when its id is unknown, changed when its transcript grew. */
export function selectChanged(sessions, state) {
  const fresh = []
  for (const session of sessions) {
    const known = state.hosts[session.host] && state.hosts[session.host][session.sessionId]
    if (!known || Number(known.updatedAt || 0) !== Number(session.updatedAt || 0)) fresh.push(session)
  }
  return fresh
}

/** Marks the given sessions as seen and appends one run record. */
export function mergeState(state, sessions, { runAt, hostReports = [] } = {}) {
  const next = {
    version: STATE_VERSION,
    hosts: { ...(state.hosts || {}) },
    runs: Array.isArray(state.runs) ? state.runs.slice(0, 49) : [],
  }
  for (const session of sessions) {
    const host = (next.hosts[session.host] = next.hosts[session.host] || {})
    const prior = host[session.sessionId] || {}
    host[session.sessionId] = {
      firstSeen: prior.firstSeen || Number(session.startedAt || session.updatedAt || runAt),
      updatedAt: Number(session.updatedAt || runAt),
      risk: session.risk,
    }
  }
  next.runs.unshift({ at: runAt, sessions: sessions.length, hosts: hostReports })
  next.runs = next.runs.slice(0, 50)
  return next
}

/** Coarse flags the improvement pass starts from; the skill owns the judgement. */
export function classifySession(session) {
  const flags = []
  const denials = session.denials || {}
  const denialTotal = Object.values(denials).reduce((sum, value) => sum + Number(value || 0), 0)
  if (session.rage > 0) flags.push('user-rage')
  if (session.asks >= 3) flags.push('ask-heavy')
  if (denialTotal > 0) flags.push('gate-friction')
  if (session.maxTurnSec > 900) flags.push('long-turn')
  if (session.emptyTurns > 0) flags.push('idle-turn')
  if (session.turns >= 50) flags.push('long-loop')
  if (session.toolCalls >= 800) flags.push('tool-heavy')
  return flags
}

/** Sorting score: user anger first, then questions, then wasted rounds. */
export function riskScore(session) {
  const denialTotal = Object.values(session.denials || {}).reduce((sum, value) => sum + Number(value || 0), 0)
  return (
    Number(session.rage || 0) * 3 +
    Number(session.asks || 0) * 2 +
    Number(session.longTurns || 0) +
    Number(session.emptyTurns || 0) +
    (denialTotal > 0 ? 1 : 0)
  )
}

/** Aggregates the window so a recurring pattern is visible without reading rows. */
export function aggregateSessions(sessions) {
  const totals = {
    sessions: sessions.length,
    turns: 0,
    toolCalls: 0,
    asks: 0,
    rage: 0,
    denialTotal: 0,
    longTurns: 0,
    emptyTurns: 0,
    denials: {},
    hosts: {},
  }
  for (const session of sessions) {
    totals.turns += Number(session.turns || 0)
    totals.toolCalls += Number(session.toolCalls || 0)
    totals.asks += Number(session.asks || 0)
    totals.rage += Number(session.rage || 0)
    totals.longTurns += Number(session.longTurns || 0)
    totals.emptyTurns += Number(session.emptyTurns || 0)
    for (const [label, count] of Object.entries(session.denials || {})) {
      totals.denials[label] = (totals.denials[label] || 0) + Number(count || 0)
      totals.denialTotal += Number(count || 0)
    }
    const host = (totals.hosts[session.host] = totals.hosts[session.host] || {
      sessions: 0,
      turns: 0,
      toolCalls: 0,
      asks: 0,
      rage: 0,
      risk: 0,
    })
    host.sessions += 1
    host.turns += Number(session.turns || 0)
    host.toolCalls += Number(session.toolCalls || 0)
    host.asks += Number(session.asks || 0)
    host.rage += Number(session.rage || 0)
    host.risk += riskScore(session)
  }
  return totals
}

function cell(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\|/gu, '\\|').replace(/\n/gu, ' ')
}

function localTime(ms) {
  if (!ms) return '?'
  try {
    return new Date(ms).toLocaleString('sv-SE', { hour12: false }).slice(0, 16)
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
  }
}

function truncate(text, max) {
  const value = String(text || '').replace(/\s+/gu, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** Renders the Markdown brief the improvement pass reads. */
export function renderReport({ runAt, days, hosts, sessions, state }) {
  const stamp = new Date(runAt).toISOString()
  const totals = aggregateSessions(sessions)
  const lines = []
  lines.push('# Wish-preset session review')
  lines.push('')
  lines.push(`Run at ${stamp}; window ${days} day(s); ${sessions.length} new or changed top-level \`code-vibe\` session(s). Times below are the runner's local clock.`)
  lines.push('')
  lines.push('This file is mechanical evidence, not a verdict. The improvement pass reads it, opens the flagged transcripts with `--excerpt`, and only then decides whether the preset (persona or skill) needs a change.')
  lines.push('')
  lines.push('## Totals')
  lines.push('')
  lines.push('| Host | Sessions | Turns | Tool calls | Asks | Rage msgs | Risk |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const host of hosts) {
    const row = totals.hosts[host] || { sessions: 0, turns: 0, toolCalls: 0, asks: 0, rage: 0, risk: 0 }
    lines.push(`| ${cell(host)} | ${row.sessions} | ${row.turns} | ${row.toolCalls} | ${row.asks} | ${row.rage} | ${row.risk} |`)
  }
  lines.push(`| **all** | **${totals.sessions}** | **${totals.turns}** | **${totals.toolCalls}** | **${totals.asks}** | **${totals.rage}** | ${Object.values(totals.hosts).reduce((sum, row) => sum + row.risk, 0)} |`)
  lines.push('')
  const denialRows = Object.entries(totals.denials).sort((a, b) => b[1] - a[1])
  lines.push('## Policy-layer friction')
  lines.push('')
  if (denialRows.length === 0) {
    lines.push('No denial text appeared in the window. A present-day ask or stop therefore came from the preset itself, not from a gate.')
  } else {
    lines.push('| Cause | Count |')
    lines.push('| --- | --- |')
    for (const [label, count] of denialRows) lines.push(`| ${cell(label)} | ${count} |`)
  }
  lines.push('')
  lines.push('## Sessions by risk')
  lines.push('')
  if (sessions.length === 0) {
    lines.push('No new or changed session in this window. "No change this round" is the correct outcome; do not invent an improvement.')
  } else {
    lines.push('| Risk | Host | Session | Window | Turns | Asks | Rage | Max turn | Flags | First user message |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    const ordered = [...sessions].sort((a, b) => riskScore(b) - riskScore(a))
    for (const session of ordered) {
      const started = localTime(session.startedAt)
      const updated = localTime(session.updatedAt)
      const flags = classifySession(session)
      lines.push(
        `| ${riskScore(session)} | ${cell(session.host)} | \`${cell(session.sessionId)}\` | ${started} -> ${updated} | ${session.turns} | ${session.asks} | ${session.rage} | ${session.maxTurnSec}s | ${flags.join(', ') || '-'} | ${cell(truncate(session.firstUser, 110))} |`,
      )
    }
  }
  lines.push('')
  const flagged = sessions.filter((session) => session.rage > 0 || session.asks >= 3 || (session.denials && Object.keys(session.denials).length > 0))
  lines.push('## Evidence excerpts')
  lines.push('')
  if (flagged.length === 0) {
    lines.push('No session in this window carries user anger, repeated questions or policy friction.')
  } else {
    for (const session of flagged.slice(0, 12)) {
      lines.push(`### ${session.host} / \`${session.sessionId}\``)
      lines.push('')
      lines.push(`- asked ${session.asks} time(s), ${session.rage} angry message(s), ${session.longTurns} turn(s) over 10 min`)
      if ((session.rageSamples || []).length > 0) {
        for (const sample of session.rageSamples) lines.push(`- user: ${truncate(sample, 160)}`)
      }
      if (session.lastFinal) lines.push(`- last reply: ${truncate(session.lastFinal, 220)}`)
      lines.push(`- open it with: \`node scripts/wish-preset-review.mjs --excerpt ${session.host}:${session.file}\``)
      lines.push('')
    }
  }
  lines.push('## How to turn this into a preset change')
  lines.push('')
  lines.push('A reading alone is not a defect. Require the same failure in at least two sessions (or one session plus a reproducible probe), name the persona or skill sentence that permitted it, change that sentence, and keep the change reviewable in one diff. Run `pnpm preset:check`, `pnpm test:scripts` and `pnpm docs:check`; commit on `dev`. Publishing and fleet rollout are separate outward actions and stay behind the user’s explicit go-ahead.')
  lines.push('')
  return lines.join('\n')
}

function expandHome(path, { home = homedir() } = {}) {
  if (!path) return path
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

function runShell(script, { input, timeoutMs = 600000, cwd } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn('/bin/sh', ['-c', script], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveRun({ code: -1, stdout, stderr: `${stderr}${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveRun({ code, stdout, stderr })
    })
    child.stdin.end(input === undefined ? '' : input)
  })
}

function runSsh(alias, script, { input, timeoutMs = 600000 } = {}) {
  return new Promise((resolveRun) => {
    const hasInput = input !== undefined
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', alias, hasInput ? script : 'sh -s']
    const child = spawn('ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveRun({ code: -1, stdout, stderr: `${stderr}${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveRun({ code, stdout, stderr })
    })
    child.stdin.end(hasInput ? input : script)
  })
}

function runOnMachine(machine, script, options = {}) {
  return machine.local ? runShell(script, options) : runSsh(machine.ssh, script, options)
}

/** Installs the analyzer once per machine, then asks it to analyze the window. */
export async function analyzeMachine(machine, { sessionsRoot, sinceMs, limit, timeoutMs }) {
  const install = await runOnMachine(machine, `cat > ${ANALYZER_REMOTE_PATH}`, { input: ANALYZER_SOURCE, timeoutMs: 60000 })
  if (install.code !== 0) {
    return { ok: false, error: `install analyzer failed (${install.code}): ${truncate(install.stderr, 300)}`, sessions: [] }
  }
  const command = [
    'python3',
    ANALYZER_REMOTE_PATH,
    '--root',
    JSON.stringify(sessionsRoot),
    '--since',
    String(Math.floor(sinceMs / 1000)),
    '--limit',
    String(limit),
    '--preset',
    'code-vibe',
  ].join(' ')
  const result = await runOnMachine(machine, command, { timeoutMs })
  if (result.code !== 0) {
    return { ok: false, error: `analyzer failed (${result.code}): ${truncate(result.stderr, 300)}`, sessions: [] }
  }
  return { ok: true, error: null, sessions: parseAnalyzerOutput(result.stdout, machine.name) }
}

/** Fetches one transcript excerpt for evidence, from the machine that owns it. */
export async function fetchExcerpt(machines, target) {
  const separator = target.indexOf(':')
  if (separator < 0) throw new Error('--excerpt expects <host>:<absolute session path>')
  const host = target.slice(0, separator)
  const path = target.slice(separator + 1)
  const machine = machines.find((candidate) => candidate.name === host)
  if (!machine) throw new Error(`unknown host ${host}`)
  const install = await runOnMachine(machine, `cat > ${ANALYZER_REMOTE_PATH}`, { input: ANALYZER_SOURCE, timeoutMs: 60000 })
  if (install.code !== 0) throw new Error(`install analyzer failed (${install.code})`)
  const result = await runOnMachine(
    machine,
    `python3 ${ANALYZER_REMOTE_PATH} --excerpt ${JSON.stringify(path)}`,
    { timeoutMs: 300000 },
  )
  if (result.code !== 0) throw new Error(`excerpt failed (${result.code}): ${truncate(result.stderr, 300)}`)
  return JSON.parse(result.stdout)
}

export function helpText() {
  return [
    'wish-preset-review: incremental code-vibe session extraction for the preset improvement loop',
    '',
    'Options:',
    '  --days N        look-back window in days (default 7)',
    '  --hosts a,b     only these fleet machines (default: every machine in the scope)',
    '  --limit N       per-machine session cap for this run (default 200)',
    '  --all           ignore the incremental state cursor',
    '  --excerpt h:p   print a compact transcript for <host>:<session path>',
    '  --json          print the run summary as JSON',
    '  --quiet         only print failures and the report path',
    '  --state PATH    state file (default .harvest/wish-preset-review/state.json)',
    '  --out DIR       report root (default .harvest/wish-preset-review)',
    '',
    'Exit: 0 ok, 1 a machine failed, 2 usage.',
  ].join('\n')
}

export async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`wish-preset-review: ${error.message}\n${helpText()}\n`)
    return 2
  }
  if (options.help) {
    process.stdout.write(`${helpText()}\n`)
    return 0
  }
  const { scope } = loadScope({ root: repoRoot })
  const allMachines = scope.machines
  if (options.excerpt) {
    try {
      const excerpt = await fetchExcerpt(allMachines, options.excerpt)
      process.stdout.write(`${JSON.stringify(excerpt, null, 2)}\n`)
      return 0
    } catch (error) {
      process.stderr.write(`wish-preset-review: ${error.message}\n`)
      return 1
    }
  }
  const machines = options.hosts
    ? allMachines.filter((machine) => options.hosts.includes(machine.name))
    : allMachines
  if (machines.length === 0) {
    process.stderr.write(`wish-preset-review: no machine matched ${JSON.stringify(options.hosts)}\n`)
    return 2
  }
  const runAt = Date.now()
  const sinceMs = runAt - options.days * 86400000
  const sessionsRoot = `${scope.dshHome.replace(/\/$/u, '')}/sessions`
  const state = readState(options.state)
  const hostReports = []
  let collected = []
  let failures = 0
  for (const machine of machines) {
    const report = await analyzeMachine(machine, {
      sessionsRoot,
      sinceMs,
      limit: options.limit,
      timeoutMs: Math.max(120000, scope.limits.sshTimeoutSeconds * 4000),
    })
    if (!report.ok) {
      failures += 1
      hostReports.push({ host: machine.name, ok: false, error: report.error, sessions: 0 })
      if (!options.quiet) process.stderr.write(`wish-preset-review: ${machine.name}: ${report.error}\n`)
      continue
    }
    const selected = options.all ? report.sessions : selectChanged(report.sessions, state)
    hostReports.push({ host: machine.name, ok: true, sessions: selected.length, scanned: report.sessions.length })
    collected = collected.concat(selected)
  }
  for (const session of collected) session.risk = riskScore(session)
  const stamp = new Date(runAt).toISOString().replace(/[:.]/gu, '-')
  const outDir = join(options.out, stamp)
  mkdirSync(outDir, { recursive: true })
  const reportPath = join(outDir, 'REPORT.md')
  writeFileSync(reportPath, renderReport({ runAt, days: options.days, hosts: machines.map((machine) => machine.name), sessions: collected, state }))
  writeFileSync(join(outDir, 'sessions.json'), `${JSON.stringify({ runAt, days: options.days, sessions: collected }, null, 2)}\n`)
  const nextState = mergeState(state, collected, { runAt, hostReports })
  mkdirSync(dirname(options.state), { recursive: true })
  writeFileSync(options.state, `${JSON.stringify(nextState, null, 2)}\n`)
  const summary = {
    runAt,
    days: options.days,
    report: reportPath,
    hosts: hostReports,
    sessions: collected.length,
    totals: aggregateSessions(collected),
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } else if (!options.quiet) {
    process.stdout.write(`wish-preset-review: ${collected.length} new or changed session(s) from ${machines.length} machine(s)\n`)
    process.stdout.write(`report: ${reportPath}\n`)
  }
  return failures > 0 ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code
  })
}