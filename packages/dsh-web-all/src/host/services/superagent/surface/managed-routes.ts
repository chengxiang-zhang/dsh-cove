import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
interface AdmissionPort {
  projects(): unknown
  enqueue(input: { requestId: string; project?: string; text: string; origin: { kind: 'trusted-host' } }): unknown
  read(id: string): unknown
}
/** This is the same admission used by the existing authenticated Feishu channel. */
export function managedWorkRoutes(port: AdmissionPort, isTrusted: (request: IncomingMessage) => boolean): WebRoute[] {
  const reply = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)) }
  return ['projects','intake','status'].map(operation => ({ kind: 'exact' as const, path: '/superagent/managed/' + operation,
    async handler(request: IncomingMessage, response: ServerResponse) {
      if (!isTrusted(request)) { reply(response, 403, { error: 'forbidden' }); return }
      if (request.method !== (operation === 'projects' ? 'GET' : 'POST')) { reply(response, 405, { error: 'method-not-allowed' }); return }
      if (operation === 'projects') { reply(response, 200, port.projects()); return }
      let bytes = 0; const chunks: Buffer[] = []
      for await (const chunk of request) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > 65536) { reply(response, 413, { error: 'body-too-large' }); return }; chunks.push(buffer) }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!body || typeof body.requestId !== 'string' || !body.requestId || Object.keys(body).some(k => !['requestId','project','text'].includes(k))) throw new Error('MANAGED_INTAKE_INVALID')
        if (operation === 'status') { reply(response, 200, port.read(body.requestId)); return }
        if (typeof body.text !== 'string' || (body.project !== undefined && typeof body.project !== 'string')) throw new Error('MANAGED_INTAKE_INVALID')
        reply(response, 202, port.enqueue({ requestId: body.requestId, text: body.text, ...(body.project ? { project: body.project } : {}), origin: { kind: 'trusted-host' } }))
      } catch (error) { reply(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
    }
  }))
}
