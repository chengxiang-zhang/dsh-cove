/**
 * JSON request/response helpers. Kept tiny on purpose; the manager layer
 * owns the response shape (`MutationResult` / `WorktreeErrorView`) and the
 * route layer only does envelope + status code translation.
 * @module dsh-client-ui-worktree/host/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Read a JSON object body. Returns `null` for empty bodies, throws otherwise. */
export async function readJsonObject(req: IncomingMessage, limit = 1024 * 1024): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    received += chunk.length
    if (received > limit) {
      req.destroy()
      throw new Error('request body too large')
    }
    chunks.push(chunk as Buffer)
  }
  if (received === 0) return null
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return null
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected JSON object body')
  }
  return parsed as Record<string, unknown>
}

/** Write a JSON response with the given status. */
export function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}
