/**
 * ssh 终端 WebSocket 升级（registerUpgrade + noServer wss）。
 *
 * 帧协议见 core/ssh/protocol.ts：host -> client 的 ready/output/exit/
 * auth_prompt，client -> host 的 input/resize/auth_response。信任围栏为共享的
 * 宿主访问围栏（loopback，或部署声明的 trusted authority + 已登录会话）。
 * 密码认证且提示为 password 时自动应答，其余键盘交互提示转发为 auth_prompt 帧。
 */
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SSH_API, type TerminalClientFrame, type TerminalServerFrame } from '../../../core/ssh/protocol.ts'
import type { SshEngine, KeyboardInteractiveHandler, ShellSession } from './engine.ts'
import type { HostStore } from './store.ts'
import { accessTrustOf } from '../access-trust/index.ts'

/** 发送缓冲背压阈值。 */
const BACKPRESSURE_HIGH_WATER = 1024 * 1024
const BACKPRESSURE_LOW_WATER = 512 * 1024

function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** 注册 /api/dsh-ssh/terminal 的 WS 升级处理。 */
export function registerTerminalUpgrade(ctx: Context, deps: { engine: SshEngine; store: HostStore }): () => void {
  const { engine, store } = deps
  const wss = new WebSocketServer({ noServer: true })
  const isTrusted = accessTrustOf(ctx).isTrusted
  const dispose = ctx.webServer.registerUpgrade({
    path: SSH_API.terminal,
    handler: (req, socket, head) => {
      if (!isTrusted(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const alias = queryParam(url, 'alias')
      if (alias === undefined) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const cols = Number.parseInt(queryParam(url, 'cols') ?? '80', 10)
      const rows = Number.parseInt(queryParam(url, 'rows') ?? '24', 10)
      wss.handleUpgrade(req, socket as Duplex, head, (ws) => {
        attach({ engine, store }, ws, alias, Number.isFinite(cols) ? cols : 80, Number.isFinite(rows) ? rows : 24)
      })
    },
  })
  return () => {
    dispose()
    wss.close()
  }
}

function attach(
  deps: { engine: SshEngine; store: HostStore },
  ws: WebSocket,
  alias: string,
  cols: number,
  rows: number,
): void {
  const { engine, store } = deps
  let session: ShellSession | undefined
  let closed = false
  let paused = false
  let pendingAuthFinish: ((responses: string[]) => void) | undefined

  const resume = (): void => {
    if (paused && ws.bufferedAmount < BACKPRESSURE_LOW_WATER) {
      paused = false
      session?.resume()
    }
  }
  const sendFrame = (frame: TerminalServerFrame): void => {
    if (closed || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(frame), resume)
    if (!paused && ws.bufferedAmount > BACKPRESSURE_HIGH_WATER) {
      paused = true
      session?.pause()
    }
  }
  const closeSession = (): void => {
    if (pendingAuthFinish !== undefined) {
      const finish = pendingAuthFinish
      pendingAuthFinish = undefined
      try { finish([]) } catch { /* ignore */ }
    }
    const opened = session
    session = undefined
    if (opened !== undefined) opened.close()
  }

  const onKeyboardInteractive: KeyboardInteractiveHandler = (name, instructions, _lang, prompts, finish) => {
    const entry = store.find(alias)
    if (entry?.auth.kind === 'password' && entry.auth.password !== undefined && prompts.length > 0 && prompts.every(p => /password/i.test(p.prompt))) {
      const password = entry.auth.password
      finish(prompts.map(() => password))
      return
    }
    pendingAuthFinish = finish
    sendFrame({ type: 'auth_prompt', name, instructions, prompts: prompts.map(p => ({ prompt: p.prompt, echo: p.echo })) })
  }

  void engine.openShell(alias, { cols, rows }, onKeyboardInteractive).then((opened) => {
    if (ws.readyState !== WebSocket.OPEN) {
      opened.close()
      return
    }
    session = opened
    sendFrame({ type: 'ready', alias })
    opened.onData = (data) => sendFrame({ type: 'output', data: data.toString('utf8') })
    opened.onExit = (code, error) => {
      sendFrame({ type: 'exit', code, error })
      closed = true
      try { ws.close(1000) } catch { /* already closed */ }
    }
  }).catch((error) => {
    sendFrame({ type: 'exit', code: null, error: error instanceof Error ? error.message : String(error) })
    closed = true
    try { ws.close(1000) } catch { /* already closed */ }
  })

  ws.on('message', (data) => {
    let frame: TerminalClientFrame
    try {
      frame = JSON.parse(String(data)) as TerminalClientFrame
    } catch {
      return
    }
    if (frame.type === 'input') {
      session?.send(frame.data)
    } else if (frame.type === 'resize') {
      session?.resize(frame.cols, frame.rows)
    } else if (frame.type === 'auth_response') {
      if (pendingAuthFinish !== undefined) {
        const finish = pendingAuthFinish
        pendingAuthFinish = undefined
        finish(frame.responses)
      }
    }
  })
  ws.on('close', () => {
    closed = true
    closeSession()
  })
  ws.on('error', () => {
    closed = true
    closeSession()
  })
}
