/**
 * Same-origin host routes for the credential wizard.
 *
 * The wizard drives a host-side Lark login (it opens a verification URL and
 * accepts the app secret), so it admits exactly what every other privileged
 * web-all host surface admits: the deployment's declared browser entry with an
 * authenticated session, or a loopback page. The strict loopback rule stays the
 * default so a partially mounted plugin can never widen access.
 */

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { WizardSettingsUnavailableError, type LarkWizard, type WizardPhase } from './wizard.ts'
import { isLoopbackRequest } from '../access-trust/trust.ts'

export const LARK_WIZARD_PREFIX = '/lark-inbox/wizard'
const BODY_LIMIT = 16 * 1024

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > BODY_LIMIT) { request.destroy(); return null }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch { return null }
}

function statusPayload(state: WizardPhase): Record<string, unknown> {
  switch (state.phase) {
    case 'idle': return { phase: 'idle' }
    case 'awaiting-browser': return { phase: 'awaiting-browser', mode: 'new' }
    case 'awaiting-secret': return { phase: 'awaiting-secret', mode: 'bind', consoleUrl: state.consoleUrl }
    case 'done': return { phase: 'done', appId: state.appId, needsSecretPaste: state.needsSecretPaste }
    case 'failed': return { phase: 'failed', error: state.error }
  }
}

/**
 * Build the wizard routes.
 * @param wizard - the credential wizard driving the host-side login.
 * @param isTrusted - host access fence; defaults to the shared strict loopback rule.
 * @param enabled - whether the feature is enabled right now (read per request).
 * @returns the routes to register on the web server.
 */
export function makeLarkWizardRoutes(
  wizard: LarkWizard,
  isTrusted: (request: IncomingMessage) => boolean = isLoopbackRequest,
  enabled: () => boolean = () => true,
): WebRoute[] {
  const guard = (request: IncomingMessage, response: ServerResponse, method: string): boolean => {
    if (!isTrusted(request)) { writeJson(response, 403, { error: 'forbidden: loopback-only' }); return false }
    // 路由随服务域一起挂载（开关只影响运行时），禁用状态仍然要拒绝写凭据：
    // 否则关闭的功能保留一条能写入 appSecret 的活口。
    if (!enabled()) { writeJson(response, 409, { error: 'lark-inbox-disabled' }); return false }
    if (request.method !== method) { writeJson(response, 405, { error: 'method-not-allowed' }); return false }
    return true
  }
  return [
    { kind: 'exact', path: `${LARK_WIZARD_PREFIX}/start-new`, handler: async (request, response) => {
      if (!guard(request, response, 'POST')) return
      try {
        const { verificationUrl, qrFilePath } = await wizard.startNew()
        writeJson(response, 200, { verificationUrl, qr: qrFilePath === null ? null : `${LARK_WIZARD_PREFIX}/qr.png` })
      } catch (error) {
        writeJson(response, error instanceof WizardSettingsUnavailableError ? 503 : 500, { error: error instanceof Error ? error.message : String(error) })
      }
    } },
    { kind: 'exact', path: `${LARK_WIZARD_PREFIX}/start-bind`, handler: async (request, response) => {
      if (!guard(request, response, 'POST')) return
      const body = await readJson(request)
      if (body === null || typeof body.appId !== 'string' || !body.appId.startsWith('cli_')) { writeJson(response, 400, { error: 'appId 必须以 cli_ 开头' }); return }
      writeJson(response, 200, wizard.startBind(body.appId))
    } },
    { kind: 'exact', path: `${LARK_WIZARD_PREFIX}/finish-bind`, handler: async (request, response) => {
      if (!guard(request, response, 'POST')) return
      const body = await readJson(request)
      if (body === null || typeof body.appSecret !== 'string' || body.appSecret.trim() === '') { writeJson(response, 400, { error: 'appSecret 不能为空' }); return }
      try { await wizard.finishBind(body.appSecret); writeJson(response, 200, { ok: true }) }
      catch (error) { writeJson(response, error instanceof WizardSettingsUnavailableError ? 503 : 400, { error: error instanceof Error ? error.message : String(error) }) }
    } },
    { kind: 'exact', path: `${LARK_WIZARD_PREFIX}/status`, handler: (request, response) => {
      if (!guard(request, response, 'GET')) return
      writeJson(response, 200, statusPayload(wizard.state()))
    } },
    { kind: 'exact', path: `${LARK_WIZARD_PREFIX}/qr.png`, handler: async (request, response) => {
      if (!guard(request, response, 'GET')) return
      const state = wizard.state()
      const path = state.phase === 'awaiting-browser' ? state.qrFilePath : null
      if (path === null) { response.writeHead(404, { 'cache-control': 'no-store' }); response.end(); return }
      try { const data = await readFile(path); response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); response.end(data) }
      catch { response.writeHead(404, { 'cache-control': 'no-store' }); response.end() }
    } },
    { kind: 'exact', path: `${LARK_WIZARD_PREFIX}/cancel`, handler: async (request, response) => {
      if (!guard(request, response, 'POST')) return
      await wizard.cancel()
      writeJson(response, 200, { ok: true })
    } },
  ]
}
