/**
 * The /api/dsh-codex-bridge route family: bridge status, device-code login
 * lifecycle, proxy restart, and chain verification. Every route carries the
 * shared loopback-only trust fence (plus browser same-origin markers) — the
 * device login and proxy control are local operations and must never be
 * served to LAN-exposed dsh web deployments.
 *
 * The fence is the generated copy of `shared/host/loopback.ts` (synced by
 * `node scripts/sync-shared.mjs`, checked by `pnpm test:scripts`), so this
 * family applies exactly the shared strict rule.
 *
 * This is a host-only control surface: the browser half of this package has no
 * consumer for it, and the envelopes stay byte-for-byte compatible with the
 * pre-merge `@dsh-cove/dsh-codex-bridge` responses for external callers.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { isLoopbackRequest } from './loopback.ts'
import { writeJson } from './http.ts'
import { checkCodexAuth } from './codex-auth.ts'
import type { ApiProxyBridge } from './bridge.ts'
import { registerProvider, PROVIDER_ROUTE } from './dsh-integration.ts'
import type { Context } from '@deepseek-ai/cordis'

export interface BridgeRoutesDeps {
  bridge: ApiProxyBridge
  /** Host context used for DSH provider registration. */
  ctx: Context
  /** Path of the codex auth file (status only; login writes through the bridge). */
  authFile: string
  /** Re-run automatic registration after a successful login. */
  onLoginComplete?: () => Promise<void>
}

/** Owns the loopback fence plus a JSON envelope for every route. */
function guard(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { error: 'loopback only' })
    return false
  }
  return true
}

export function makeRoutes(deps: BridgeRoutesDeps): WebRoute[] {
  const { bridge, ctx, authFile, onLoginComplete } = deps

  const statusRoute: WebRoute = {
    kind: 'exact',
    path: '/api/dsh-codex-bridge/status',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const auth = checkCodexAuth(authFile)
      const status = await bridge.status(auth)
      writeJson(res, 200, { ...status, login: bridge.deviceLoginState() })
    },
  }

  const loginStart: WebRoute = {
    kind: 'exact',
    path: '/api/dsh-codex-bridge/login/start',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      try {
        const grant = await bridge.startDeviceLogin()
        writeJson(res, 200, {
          verificationUrl: grant.verificationUrl,
          userCode: grant.userCode,
          intervalSec: grant.intervalSec,
          expiresInSec: 15 * 60,
        })
      } catch (error) {
        writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  const loginStatus: WebRoute = {
    kind: 'exact',
    path: '/api/dsh-codex-bridge/login/status',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const state = bridge.deviceLoginState()
      if (state.phase === 'success' && onLoginComplete) {
        await onLoginComplete()
      }
      writeJson(res, 200, state)
    },
  }

  const loginCancel: WebRoute = {
    kind: 'exact',
    path: '/api/dsh-codex-bridge/login/cancel',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      bridge.cancelDeviceLogin()
      writeJson(res, 200, { cancelled: true })
    },
  }

  const proxyRestart: WebRoute = {
    kind: 'exact',
    path: '/api/dsh-codex-bridge/proxy/restart',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      try {
        await bridge.restart()
        writeJson(res, 200, { restarted: true, baseURL: bridge.baseURL })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  const verify: WebRoute = {
    kind: 'exact',
    path: '/api/dsh-codex-bridge/verify',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const result = await bridge.verify()
      writeJson(res, result.ok ? 200 : 502, result)
    },
  }

  const register: WebRoute = {
    kind: 'exact',
    path: '/api/dsh-codex-bridge/register',
    handler: async (req, res) => {
      if (!guard(req, res)) return
      try {
        const models = await bridge.listModels()
        const result = await registerProvider(ctx, bridge.baseURL, bridge.apiKey(), models)
        writeJson(res, 200, { ...result, route: PROVIDER_ROUTE })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  return [statusRoute, loginStart, loginStatus, loginCancel, proxyRestart, verify, register]
}