#!/usr/bin/env node
/**
 * dsh-netbird-llm-apply - apply the canonical fleet LLM preset
 * (tools/dsh-netbird/llm-models.patch.yml) to one or more machines over SSH.
 *
 * Why an SSH apply command instead of plain `git pull` on every machine:
 * the deployment target is each machine's $DSH_HOME/profiles/web/cordis.patch.yml
 * (runtime state that lives in no repository) plus per-machine credential refs
 * that must never transit the repository. Git remains the transport and review
 * surface for the PRESET itself; this command is the machine-local last mile.
 *
 * The merge runs on the ops workstation (fetch profile via ssh, merge locally,
 * write back): every merge step is a pure, unit-tested function, and the remote
 * side only needs cat/tee plus service control. Machine-local secrets move only
 * between that machine's own files (--copy-ref) or through a direct pipe from
 * another machine (--ref-stdin); they never touch this repository or argv.
 *
 * Usage:
 *   node scripts/dsh-netbird-llm-apply.mjs [--dry-run] [--no-restart]
 *        [--copy-ref SRC:DST]... [--ref-stdin NAME] [ssh-alias...]
 *
 *   - Default host set: every machines.json entry with an sshAlias.
 *   - --copy-ref SRC:DST   upsert refs.DST from the machine's own refs.SRC
 *                          (for example KAON_API_KEY:KAON_ROUTER_API_KEY).
 *   - --ref-stdin NAME     read one line from stdin as refs.NAME on the target
 *                          (pipe from the key-owning machine: ssh nb-a '...' |
 *                           pnpm dsh-netbird:llm-apply --ref-stdin NAME nb-b).
 *   - --dry-run            fetch and merge, print the diff, change nothing.
 *   - --no-restart         apply files but leave service restart to the admin.
 *
 * Restarts use per-machine service control and follow the fleet contract:
 * the running DSH host of the operator (ssh-studio-mac) is always refused.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { loadDeploymentConfig, requireString } from './lib/deployment-config.mjs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_PATH = resolve(root, 'tools/dsh-netbird/llm-models.patch.yml')
const INVENTORY_PATH = resolve(root, 'tools/dsh-netbird/machines.json')

export const PROFILE_PATH = '~/.dsh/profiles/web/cordis.patch.yml'
export const CREDENTIALS_PATH = '~/.dsh/.credentials.yaml'

/** Per-alias service control. `restart` receives `stop` then `start` phases. */
export function servicePlan(alias) {
  const launchd = {
    stop: 'launchctl bootout gui/$(id -u)/org.dsh.web 2>/dev/null || true',
    start: 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.dsh.web.plist',
  }
  switch (alias) {
    case 'ssh-studio-mac':
      return { refused: 'ssh-studio-mac is the operator\'s running DSH host; restart it manually per the repository rules' }
    case 'ssh-laptop-b':
    case 'ssh-imac-office':
      return launchd
    case 'ssh-thinkpad-lab':
      return { restart: ['sudo -n systemctl restart dsh-cove'] }
    case 'ssh-tower-lab':
      return { restart: ['systemctl --user restart com.dsh.web.service'] }
    case 'nb-tx':
      return { restart: ['systemctl restart dsh-cove'] }
    default:
      return { unknown: true }
  }
}

/** Top-level `- id: <entryId>` entry span [start, end); end is the next `^- ` line. */
export function findEntrySpan(text, entryId) {
  const re = new RegExp(`^- id: ${entryId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm')
  const m = re.exec(text)
  if (!m) return null
  const next = /^- /m.exec(text.slice(m.index + m[0].length))
  const end = next ? m.index + m[0].length + next.index : text.length
  return [m.index, end]
}

/** Provider block span inside an llm entry: `      name:` to the next 6-indent key. */
export function providerSpan(entryText, name) {
  const re = new RegExp(`^      ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`, 'm')
  const m = re.exec(entryText)
  if (!m) return null
  const next = /^      [A-Za-z0-9_-]+:\s*$/m.exec(entryText.slice(m.index + m[0].length))
  const end = next ? m.index + m[0].length + next.index : entryText.length
  return [m.index, end]
}

/** Split the canonical preset into the pieces the merge splices in. */
export function splitPreset(presetText) {
  const llm = findEntrySpan(presetText, 'llm-pi-ai')
  if (!llm) throw new Error('preset: llm-pi-ai entry missing')
  const llmEntry = presetText.slice(llm[0], llm[1]).replace(/\n+$/, '\n')
  const providers = {}
  for (const name of ['router', 'codex-local', 'hiopen']) {
    const span = providerSpan(llmEntry, name)
    if (!span) throw new Error(`preset: provider block missing: ${name}`)
    providers[name] = llmEntry.slice(span[0], span[1]).replace(/\n+$/, '\n')
  }
  const dm = findEntrySpan(presetText, 'agent-default-model')
  if (!dm) throw new Error('preset: agent-default-model entry missing')
  return {
    llmEntry,
    krBlock: providers['router'],
    clBlock: providers['codex-local'],
    hiopenBlock: providers['hiopen'],
    dmEntry: presetText.slice(dm[0], dm[1]).replace(/\n+$/, '\n'),
  }
}

/** Merge the canonical providers and default-model row into a profile text. */
export function mergeProfileText(profileText, preset) {
  const actions = []
  let text = profileText
  const providerOrder = ['router', 'codex-local', 'hiopen']
  const entry = findEntrySpan(text, 'llm-pi-ai')
  if (!entry) {
    text = text.replace(/\n+$/, '') + '\n\n' + preset.llmEntry.replace(/\n+$/, '\n')
    actions.push(`inserted llm-pi-ai entry (${providerOrder.join(' + ')})`)
  } else {
    const [s, e] = entry
    let llm = text.slice(s, e)
    for (const name of providerOrder) {
      const blockKey = { 'router': 'krBlock', 'codex-local': 'clBlock', hiopen: 'hiopenBlock' }[name]
      const block = preset[blockKey]
      const pb = providerSpan(llm, name)
      if (pb) {
        llm = llm.slice(0, pb[0]) + block + llm.slice(pb[1])
        actions.push(`replaced provider ${name}`)
      } else {
        const pm = /^    providers:\s*$/m.exec(llm)
        if (!pm) throw new Error('llm-pi-ai entry has no providers map; refusing to merge')
        llm = llm.slice(0, pm.index + pm[0].length) + '\n' + block.replace(/\n+$/, '') + llm.slice(pm.index + pm[0].length)
        actions.push(`inserted provider ${name}`)
      }
    }
    const tail = text.slice(e)
    text = text.slice(0, s) + llm.replace(/\n+$/, '') + '\n\n' + tail.replace(/^\n+/, '')
  }
  const dm = findEntrySpan(text, 'agent-default-model')
  if (dm) {
    text = text.slice(0, dm[0]) + preset.dmEntry.replace(/\n+$/, '\n') + text.slice(dm[1]).replace(/^\n+/, '')
    actions.push('replaced agent-default-model')
  } else {
    text = text.replace(/\n+$/, '') + '\n\n' + preset.dmEntry.replace(/\n+$/, '\n')
    actions.push('inserted agent-default-model')
  }
  return { text, actions }
}

/** Parse the `refs:` map of a credentials file (YAML 1.1 tolerant, text-based). */
export function parseRefs(credText) {
  const refs = {}
  const m = /^refs:\s*$/m.exec(credText)
  if (!m) return refs
  const seg = credText.slice(m.index + m[0].length)
  const next = /^[^ \t\n]/m.exec(seg)
  const body = next ? seg.slice(0, next.index) : seg
  for (const line of body.split('\n')) {
    const mm = /^  ([A-Za-z0-9_]+): (.*)$/.exec(line)
    if (mm) refs[mm[1]] = mm[2]
  }
  return refs
}

/** Upsert one ref; returns { text, how } with how in added|updated. */
export function upsertRef(credText, name, value) {
  const line = `  ${name}: ${value}`
  const refLine = new RegExp(`^  ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: .*$`, 'm')
  if (refLine.test(credText)) {
    return { text: credText.replace(refLine, line), how: 'updated' }
  }
  const m = /^refs:\s*$/m.exec(credText)
  if (m) return { text: credText.slice(0, m.index + m[0].length) + '\n' + line + credText.slice(m.index + m[0].length), how: 'added' }
  return { text: credText.replace(/\n+$/, '\n') + `\nrefs:\n${line}\n`, how: 'added' }
}

/** Merge credential refs: copies within the machine plus explicit values. */
export function mergeCredentialRefs(credText, { copies = [], values = [] } = {}) {
  const refs = parseRefs(credText)
  let text = credText
  const applied = []
  for (const [name, value] of values) {
    const r = upsertRef(text, name, value)
    text = r.text
    applied.push(`${r.how} ${name}`)
  }
  for (const [src, dst] of copies) {
    if (dst in refs && !(src in refs)) continue
    if (!(src in refs)) throw new Error(`copy-ref source missing on target: ${src}`)
    const r = upsertRef(text, dst, refs[src])
    text = r.text
    applied.push(`${r.how} ${dst} (from ${src})`)
  }
  return { text, applied }
}

function ssh(alias, command, { input } = {}) {
  const r = spawnSync('ssh', ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', alias, command], {
    input: input ?? '',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0) throw new Error(`ssh ${alias} failed: ${(r.stderr || '').trim()}`)
  return r.stdout
}

function timestamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function defaultHosts() {
  const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'))
  return inventory.machines.map((m) => m.sshAlias).filter(Boolean)
}

async function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const noRestart = argv.includes('--no-restart')
  const copies = []
  const stdinRef = []
  const hosts = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run' || a === '--no-restart') { continue }
    else if (a === '--copy-ref') { copies.push(argv[++i].split(':', 2)) }
    else if (a === '--ref-stdin') { stdinRef.push(argv[++i]) }
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`)
    else hosts.push(a)
  }
  const targetHosts = hosts.length ? hosts : defaultHosts()
  if (!targetHosts.length) throw new Error('no hosts: pass ssh aliases or fill machines.json sshAlias')
  if (stdinRef.length > 1) throw new Error('only one --ref-stdin name is supported per run')

  const stdinValues = []
  for (const name of stdinRef) {
    const value = readFileSync(0, 'utf8').split('\n')[0]
    if (!value) throw new Error(`empty stdin value for ${name}`)
    stdinValues.push([name, value])
  }

  // The catalog ships a placeholder endpoint; the machine supplies the real one, so the
  // repository never carries an internal address.
  const deployment = loadDeploymentConfig()
  const endpoint = requireString('llm.hiopen.baseUrl', deployment)
  const presetSource = readFileSync(PRESET_PATH, 'utf8').split('https://llm.example.com/v1').join(endpoint)
  const preset = splitPreset(presetSource)
  const ts = timestamp()
  let failures = 0

  for (const alias of targetHosts) {
    console.log(`\n===== ${alias} =====`)
    try {
      const plan = servicePlan(alias)
      const profileRaw = ssh(alias, `cat ${PROFILE_PATH}`)
      const merged = mergeProfileText(profileRaw, preset)
      const changed = merged.text !== profileRaw
      for (const action of merged.actions) console.log(`  profile: ${action}`)
      if (!changed) console.log('  profile: already canonical (no changes)')

      let credActions = []
      let credChanged = false
      if (copies.length || stdinValues.length) {
        const credRaw = ssh(alias, `cat ${CREDENTIALS_PATH} 2>/dev/null || true`)
        const credMerged = mergeCredentialRefs(credRaw, { copies, values: stdinValues })
        credActions = credMerged.applied
        credChanged = credMerged.text !== credRaw
        for (const a of credActions) console.log(`  credentials: ${a}`)
        if (credChanged && !dryRun) {
          ssh(alias, `[ -f ${CREDENTIALS_PATH} ] && cp ${CREDENTIALS_PATH} ${CREDENTIALS_PATH}.bak.preset-${ts} || true`)
          ssh(alias, `cat > ${CREDENTIALS_PATH}`, { input: credMerged.text })
          ssh(alias, `chmod 600 ${CREDENTIALS_PATH}`)
        }
      }

      if (dryRun) {
        console.log('  dry-run: no files written, no restart')
        continue
      }

      if (plan.refused) {
        console.log(`  STOP: ${plan.refused}`)
        console.log('  profile written? NO - the running host is never modified without an explicit manual decision')
        continue
      }

      // systemd hosts: write now, restart atomically afterwards.
      // launchd hosts: the write is deferred until after `stop` so the running
      // configEditor cannot rewrite the profile from memory mid-merge.
      const deferredWrite = changed && plan.stop
      if (changed && !deferredWrite) {
        ssh(alias, `cp ${PROFILE_PATH} ${PROFILE_PATH}.bak.preset-${ts}`)
        ssh(alias, `cat > ${PROFILE_PATH}`, { input: merged.text })
      }

      if (noRestart) {
        if (deferredWrite) {
          ssh(alias, `cp ${PROFILE_PATH} ${PROFILE_PATH}.bak.preset-${ts}`)
          ssh(alias, `cat > ${PROFILE_PATH}`, { input: merged.text })
        }
        console.log('  restart: skipped by --no-restart (admin restarts)')
        continue
      }
      if (plan.unknown) {
        console.log('  restart: no service plan for this alias; restart manually')
        continue
      }
      if (plan.restart) {
        for (const cmd of plan.restart) ssh(alias, cmd)
      } else {
        ssh(alias, plan.stop)
        if (deferredWrite) {
          ssh(alias, `cp ${PROFILE_PATH} ${PROFILE_PATH}.bak.preset-${ts}`)
          ssh(alias, `cat > ${PROFILE_PATH}`, { input: merged.text })
        }
        ssh(alias, plan.start)
      }
      const probe = ssh(alias, 'sleep 6; curl -s -o /dev/null -w "%{http_code}" -m 10 http://127.0.0.1:3080/ || true')
      console.log(`  restart: done; loopback http ${probe.trim()}`)
    } catch (error) {
      failures++
      console.error(`  FAILED: ${error.message}`)
    }
  }
  if (failures) { console.error(`\n${failures} host(s) failed`); process.exitCode = 1 }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
