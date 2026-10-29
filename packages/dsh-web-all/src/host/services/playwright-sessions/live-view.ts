/** Agent-browser live view: serve one WebSocket client per session with CDP
 *  screencast (JPEG frames out) and normalized mouse/keyboard input (CDP
 *  `Input.*` commands in).
 *
 *  The session's Chromium runs as a persistent context launched by the host
 *  (see child.ts `liveView` mode); `@playwright/mcp` connects to the same
 *  browser over `--cdp-endpoint` and drives the persistent profile as the
 *  browser's DEFAULT context, so the pages it creates show up in
 *  `context.pages()`. We open a PAGE-scoped CDP session
 *  (`context.newCDPSession(page)`) — never a browser-scoped session, where
 *  the `Page.*`/`Input.*` domains are not routable — and poll
 *  `context.pages()` for the page the MCP child is actually using, so a page
 *  that appears after the first navigation, or that closes and is replaced,
 *  is picked up without a reconnect.
 */
import type { BrowserContext, Page } from 'playwright-core'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  buildFrameMessage, buildStatusMessage, mapInputMessage, type ScreencastFrame,
} from '../../../core/playwright-sessions/wire.ts'
import { accessTrustOf } from '../access-trust/index.ts'

const POLL_INTERVAL_MS = 500
/** The live-view upgrade path (client wires to this by session id). */
export const LIVE_VIEW_UPGRADE_PATH = '/playwright-sessions/ws/browser'

/** Structural page-scoped CDP session (the real playwright CDPSession satisfies it). */
interface PageCdp {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(method: string, listener: (payload: unknown) => void): unknown
  detach(): Promise<void>
}

/** Resolve a session's browser context (async; resolver must not create a
 *  browser — a live-view client opening the socket is not a tool call). */
export type LiveContextResolver = (sessionId: string) => Promise<BrowserContext | null | undefined>

/**
 * Serve a live view for `context` over `ws`. Resolves once the first poll is
 * scheduled; the connection lives until the client closes (or errors), at
 * which point the poll timer and the page CDP session are torn down.
 */
export async function serveScreencast(context: BrowserContext, ws: WebSocket): Promise<void> {
  let attachedPage: Page | undefined
  let pageCdp: PageCdp | undefined
  let noPageSent = false
  let settled = false

  const safeSend = (data: string): void => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data)
      } catch {
        // Client may have torn the socket down between the readyState read and send.
      }
    }
  }

  const sendStatus = (state: 'no-page' | 'browser-closed' | 'error', message?: string): void => {
    safeSend(buildStatusMessage(state, message))
  }

  const detach = async (): Promise<void> => {
    const cdp = pageCdp
    pageCdp = undefined
    if (cdp !== undefined) {
      try {
        await cdp.send('Page.stopScreencast')
      } catch {
        // Page may already be gone; nothing left to stop.
      }
      try {
        await cdp.detach()
      } catch {
        // Session may already be detached.
      }
    }
  }

  const attach = async (page: Page): Promise<void> => {
    attachedPage = page // synchronous intent; guards re-entry and supersedes older attaches
    await detach()
    try {
      const cdp = (await context.newCDPSession(page)) as unknown as PageCdp
      if (attachedPage !== page || settled) {
        try {
          await cdp.detach()
        } catch {
          // Superseded before it was used.
        }
        return
      }
      cdp.on('Page.screencastFrame', (params: unknown) => {
        const frame = params as ScreencastFrame
        safeSend(buildFrameMessage(frame))
        // Ack is fire-and-forget; a failed ack only pauses future frames.
        cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      })
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 })
      pageCdp = cdp
      noPageSent = false
    } catch (error) {
      pageCdp = undefined
      if (attachedPage === page && !settled) {
        sendStatus('error', `playwright-sessions: failed to start screencast: ${String(error)}`)
      }
    }
  }

  const findPage = (): Page | undefined => {
    const pages = context.pages().filter((page) => !page.isClosed())
    return pages.find((page) => page.url() !== '' && page.url() !== 'about:blank') ?? pages.at(-1)
  }

  const poll = (): void => {
    if (settled) return
    const page = findPage()
    if (page === undefined) {
      if (attachedPage !== undefined) {
        attachedPage = undefined
        void detach()
      }
      if (!noPageSent) {
        noPageSent = true
        sendStatus('no-page')
      }
      return
    }
    if (attachedPage !== page) {
      void attach(page)
    }
  }

  const onMessage = (data: unknown): void => {
    let raw: unknown
    try {
      raw = JSON.parse(String(data))
    } catch {
      return
    }
    const command = mapInputMessage(raw)
    if (command === null) return
    const cdp = pageCdp
    if (cdp === undefined) {
      sendStatus('no-page')
      return
    }
    cdp.send(command.method, command.params).catch((error) => {
      sendStatus('error', `playwright-sessions: input failed: ${String(error)}`)
    })
  }

  let pollTimer: ReturnType<typeof setInterval> | undefined
  const cleanup = (): void => {
    if (settled) return
    settled = true
    if (pollTimer !== undefined) clearInterval(pollTimer)
    ws.off('message', onMessage)
    attachedPage = undefined
    void detach()
  }

  ws.on('message', onMessage)
  ws.on('close', cleanup)
  ws.on('error', cleanup)

  // The browser (persistent context) closed while a view was attached: the
  // live session is over — tell the client and tear the view down.
  context.on('close', () => {
    if (!settled) {
      sendStatus('browser-closed')
      cleanup()
    }
  })

  pollTimer = setInterval(poll, POLL_INTERVAL_MS)
  pollTimer.unref?.()
  poll()
}

/** Register the `/playwright-sessions/ws/browser` live-view upgrade. */
export function registerLiveViewUpgrade(ctx: Context, resolveContext: LiveContextResolver): () => void {
  const wss = new WebSocketServer({ noServer: true })
  const isTrusted = accessTrustOf(ctx).isTrusted
  const dispose = ctx.webServer.registerUpgrade({
    path: LIVE_VIEW_UPGRADE_PATH,
    handler: (req, socket, head) => {
      if (!isTrusted(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId === null || sessionId === '') {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      // Resolve asynchronously (never create a browser just for a view), then
      // complete the upgrade with the resolved context or a clean refusal.
      void resolveContext(sessionId).then(context => {
        if (context === null || context === undefined) {
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket as Duplex, head, (ws) => {
          void serveScreencast(context, ws)
        })
      }, () => {
        socket.write('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n')
        socket.destroy()
      })
    },
  })
  return () => {
    dispose()
    wss.close()
  }
}