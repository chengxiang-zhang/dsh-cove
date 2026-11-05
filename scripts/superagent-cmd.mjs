#!/usr/bin/env node
/**
 * superagent-cmd: the terminal half of the host command family.
 *
 * It never touches the ledger. It posts `{ args }` to
 * `http://<host>:<port>/superagent/commands/<name>` - the route family the
 * service exposes behind the shared access fence - and turns the answer into a
 * process exit code. The server's `exitCode` is passed through unchanged, so 0
 * success, 1 failure, 2 argument or IO error and 3 no data mean the same thing in
 * a shell as they do inside the service.
 *
 * A service that is not running is an IO error (2) with the reason on stderr, not
 * a silent success: a command that cannot reach the secretary must not look like
 * one that answered "nothing in flight".
 */

import { request } from 'node:http'

const USAGE = `用法: superagent-cmd.mjs <命令> [参数...] [--host H] [--port N]
命令: status [--json] | stop C-n | brief --now | calibration | doc add <path> | doc list [q]`

/** The command names the route family exposes; one exact route per name. */
const COMMAND_NAMES = ['status', 'stop', 'brief', 'calibration', 'doc']

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3080
const TIMEOUT_MS = 10_000

/** Splits argv into global transport flags, the command name and its arguments. */
function parseArgv(argv) {
  let host = process.env.DSH_WEB_HOST ?? DEFAULT_HOST
  const rawPort = process.env.DSH_WEB_PORT
  let port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number(rawPort)
  const rest = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--host' || arg === '--port') {
      const value = argv[index + 1]
      if (value === undefined) return { error: `${arg} 缺少取值` }
      index += 1
      if (arg === '--host') host = value
      else port = Number(value)
      continue
    }
    rest.push(arg)
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { error: `端口不合法: ${String(port)}` }
  const name = rest[0]
  if (name === undefined) return { error: USAGE }
  if (!COMMAND_NAMES.includes(name)) return { error: `未知命令: ${name}` }
  return { host, port, name, args: rest.slice(1) }
}

/** Posts the command; resolves to the parsed body, or an IO error message. */
function post({ host, port, name, args }) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({ args }), 'utf8')
    const req = request({
      host,
      port,
      path: `/superagent/commands/${name}`,
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => { chunks.push(chunk) })
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body
        try {
          body = JSON.parse(text)
        } catch {
          resolve({ ioError: `服务返回的不是 JSON（HTTP ${res.statusCode ?? 0}）: ${text.slice(0, 200)}` })
          return
        }
        resolve({ status: res.statusCode ?? 0, body })
      })
    })
    req.on('timeout', () => { req.destroy(new Error(`超过 ${TIMEOUT_MS} 毫秒没有应答`)) })
    req.on('error', (error) => { resolve({ ioError: `${host}:${port} 不可达: ${error.message}` }) })
    req.end(payload)
  })
}

function exitCodeOf(body) {
  const code = body?.exitCode
  return code === 0 || code === 1 || code === 2 || code === 3 ? code : 1
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2))
  if (parsed.error !== undefined) {
    process.stderr.write(`${parsed.error}\n`)
    return 2
  }
  const answer = await post(parsed)
  if (answer.ioError !== undefined) {
    process.stderr.write(`${answer.ioError}\n`)
    return 2
  }
  const { status, body } = answer
  if (status !== 200) {
    const reason = body?.error ?? body?.json?.error ?? 'unknown'
    process.stderr.write(`HTTP ${status}: ${String(reason)}\n`)
    return status === 400 ? 2 : 1
  }
  const wantsJson = parsed.args.includes('--json') || body.text === undefined
  process.stdout.write(wantsJson ? `${JSON.stringify(body.json, null, 2)}\n` : `${body.text}\n`)
  return exitCodeOf(body)
}

process.exitCode = await main()