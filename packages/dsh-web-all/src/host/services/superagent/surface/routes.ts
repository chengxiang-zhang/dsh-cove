/**
 * The command route family: `/superagent/commands/<name>`, POST, same-origin
 * (02, 09; docs/remote-access.md invariant 2).
 *
 * Commands live inside the service because the ledger has exactly one writer (P1):
 * an outside process may ask, never write. The route family is therefore a
 * privileged host surface and consults the shared fence on every request, before
 * reading the body or touching a command - a rejected request must not run
 * anything, not even an argument parse that could write.
 *
 * The response is HTTP 200 with `{ json, text, exitCode }` whenever the command
 * ran, whatever its exit code: the exit code is the command's answer, not an
 * HTTP-level failure. Only the fence (403), the method (405) and an unreadable
 * body (400, still exit code 2) are transport-level.
 *
 * The decision itself is injected. `surface` may not import outside superagent
 * (docs/superagent/README edge table, enforced by superagent-deps.spec.ts), so the
 * composition root resolves the shared fence once and hands the resulting trust
 * object to `makeCommandRoutes`; this family consults it on every request. That
 * object re-reads the deployment's authorities and browser session on each call,
 * so one object serves the process lifetime.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { COMMAND_NAMES, EXIT_USAGE, type Commands, type CommandTrust } from './commands/index.ts'

/** Prefix of the family; one exact route per command hangs below it. */
export const COMMANDS_PREFIX = '/superagent/commands'

const BODY_LIMIT = 16 * 1024

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** `{ args: string[] }`, or null when the body is unreadable or oversized. */
async function readArgs(request: IncomingMessage): Promise<string[] | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > BODY_LIMIT) {
      request.destroy()
      return null
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const args = (parsed as { args?: unknown }).args
  if (args === undefined) return []
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return null
  return args as string[]
}

/**
 * Builds one exact route per command.
 *
 * The fence is consulted per request through the injected trust object - the same
 * shared rule every privileged family uses - so a remote browser without a
 * declared authority and a session is refused before the command sees its
 * arguments.
 */
export function makeCommandRoutes(commands: Commands, trust: CommandTrust): WebRoute[] {
  return COMMAND_NAMES.map((name) => ({
    kind: 'exact' as const,
    path: `${COMMANDS_PREFIX}/${name}`,
    async handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
      if (!trust.isTrusted(request)) {
        writeJson(response, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'method-not-allowed' })
        return
      }
      const args = await readArgs(request)
      if (args === null) {
        writeJson(response, 400, { json: { error: 'body-not-readable' }, text: '请求体不可读', exitCode: EXIT_USAGE })
        return
      }
      const result = await commands.run(name, args)
      writeJson(response, 200, result)
    },
  }))
}