// Minimal ACP stdio client: initialize -> session/new -> session/prompt.
// Usage: node acp-probe.mjs <path-to-acp-agent-bin> <cwd> <prompt> [timeoutMs]
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const [, , bin, cwd, prompt, timeoutArg] = process.argv
if (!bin || !cwd || !prompt) {
  console.error('usage: node acp-probe.mjs <bin> <cwd> <prompt> [timeoutMs]')
  process.exit(2)
}
const timeoutMs = Number(timeoutArg ?? 240000)

const child = spawn(bin, [], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
const rl = createInterface({ input: child.stdout })

let nextId = 1
const pending = new Map()
const chunks = []
let stopReason = null

const send = (method, params) => {
  const id = nextId++
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
    return
  }
  if (msg.method === 'session/update') {
    const u = msg.params?.update ?? {}
    if (process.env.ACP_DUMP) console.error('[upd] ' + u.sessionUpdate + ' ' + JSON.stringify(u).slice(0, 220))
    if (u.sessionUpdate === 'agent_message_chunk') {
      const t = u.content?.text
      if (t) chunks.push(t)
    }
  }
})

child.stderr.on('data', (b) => {
  const s = String(b).trim()
  if (s) console.error('[stderr] ' + s.slice(0, 300))
})

const fail = (e) => {
  console.error('FAIL: ' + (e?.message ?? e))
  child.kill('SIGKILL')
  process.exit(1)
}

const timer = setTimeout(() => {
  child.kill('SIGKILL')
  console.error('TIMEOUT after ' + timeoutMs + 'ms; partial=' + JSON.stringify(chunks.join('').slice(0, 300)))
  process.exit(3)
}, timeoutMs)

try {
  const init = await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  })
  console.log('init.protocolVersion=' + init.protocolVersion + ' agentCaps=' + Object.keys(init.agentCapabilities ?? {}).join(','))

  const sess = await send('session/new', { cwd, mcpServers: [] })
  const sessionId = sess.sessionId
  console.log('sessionId=' + sessionId)

  const t0 = Date.now()
  const res = await send('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] })
  stopReason = res?.stopReason
  const ms = Date.now() - t0
  console.log('stopReason=' + stopReason + ' elapsedMs=' + ms)
  console.log('FINAL: ' + chunks.join('').trim().slice(0, 800))
  clearTimeout(timer)
  child.kill('SIGTERM')
  process.exit(stopReason === 'end_turn' ? 0 : 1)
} catch (e) {
  clearTimeout(timer)
  fail(e)
}