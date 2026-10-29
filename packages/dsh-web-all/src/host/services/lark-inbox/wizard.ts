/** Host-side lark-cli credential wizard. */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export class WizardSettingsUnavailableError extends Error {
  readonly code = 'WIZARD_SETTINGS_UNAVAILABLE'
  constructor() {
    super('dsh-lark-inbox: settings 服务不可用，无法写入飞书凭据')
    this.name = 'WizardSettingsUnavailableError'
  }
}

export type WizardPhase =
  | { phase: 'idle' }
  | { phase: 'awaiting-browser'; mode: 'new'; verificationUrl: string; qrFilePath: string | null }
  | { phase: 'awaiting-secret'; mode: 'bind'; appId: string; consoleUrl: string }
  | { phase: 'done'; appId: string; needsSecretPaste: boolean }
  | { phase: 'failed'; error: string }

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface LarkWizardOptions {
  settingsWrite(patch: { appId?: string; appSecret?: string }): Promise<void>
  log?(level: 'info' | 'warn' | 'error', message: string): void
  larkCli?: string
  qrDir?: string
  spawn?: SpawnFn
}

const INSTALL_HINT = '未找到 lark-cli，请先安装：npm i -g @larksuite/cli'

function extractVerificationUrl(text: string): string | undefined {
  const field = /["'](?:verification_uri_complete|verification_url)["']\s*[:=]\s*["']([^"']+)["']/i.exec(text)
  if (field) return field[1]
  const bare = /https:\/\/open\.feishu\.cn\/[^\s"'<>]+/i.exec(text)
  return bare && !bare[0].includes('wss:') && !bare[0].includes('console') ? bare[0] : undefined
}

function extractOneTimeSecret(text: string): string | undefined {
  const context = /(?:app[_-]?secret|secret)["'\s:=]+/gi
  let match: RegExpExecArray | null
  while ((match = context.exec(text)) !== null) {
    const value = /^["']?([A-Za-z0-9._~\-]{8,})["']?/.exec(text.slice(match.index + match[0].length))?.[1]
    if (value && !/^\*+$/.test(value)) return value
  }
  return undefined
}

function redactSecrets(text: string): string {
  return text.replace(/((?:app[_-]?secret|secret)["'\s:=]+)([A-Za-z0-9._~\-]{8,}|"?\*+"?)/gi, '$1[redacted]')
}

export async function writeWithConflictRetry(write: () => Promise<void>): Promise<void> {
  try {
    await write()
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 'SETTINGS_CONFLICT') throw error
    await write()
  }
}

export class LarkWizard {
  private readonly options: LarkWizardOptions
  private readonly cli: string
  private readonly qrDir: string
  private readonly spawn: SpawnFn
  private readonly log: NonNullable<LarkWizardOptions['log']>
  private current: WizardPhase = { phase: 'idle' }
  private child: ChildProcess | undefined

  constructor(options: LarkWizardOptions) {
    this.options = options
    this.cli = options.larkCli ?? 'lark-cli'
    this.qrDir = options.qrDir ?? join(process.env.TMPDIR ?? tmpdir(), 'dsh-lark-inbox-wizard')
    this.spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions))
    this.log = options.log ?? (() => undefined)
  }

  state(): WizardPhase { return this.current }

  async startNew(): Promise<{ verificationUrl: string; qrFilePath: string | null }> {
    await this.cancel()
    await mkdir(this.qrDir, { recursive: true })
    let resolveUrl!: (url: string) => void
    let rejectUrl!: (error: Error) => void
    const urlSeen = new Promise<string>((resolve, reject) => { resolveUrl = resolve; rejectUrl = reject })
    const child = this.spawn(this.cli, ['config', 'init', '--new'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: this.qrDir, shell: false })
    this.child = child
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout?.on('data', chunk => {
      stdout += String(chunk)
      const url = extractVerificationUrl(stdout)
      if (url !== undefined && !settled) { settled = true; resolveUrl(url) }
    })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (this.child === child) this.child = undefined
      const message = error.code === 'ENOENT' ? INSTALL_HINT : `lark-cli 启动失败：${redactSecrets(error.message)}`
      this.current = { phase: 'failed', error: message }
      if (!settled) { settled = true; rejectUrl(new Error(message)) }
    })
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child === child) this.child = undefined
      if (!settled) { settled = true; rejectUrl(new Error('lark-cli 未输出授权链接即退出')); return }
      void this.completeInit(code, signal, stdout, stderr)
    })
    const verificationUrl = await urlSeen
    let qrFilePath: string | null = null
    try { if (await this.generateQr(verificationUrl)) qrFilePath = join(this.qrDir, 'qr.png') } catch { qrFilePath = null }
    if (this.child === child) this.current = { phase: 'awaiting-browser', mode: 'new', verificationUrl, qrFilePath }
    return { verificationUrl, qrFilePath }
  }

  startBind(appId: string): { consoleUrl: string } {
    const consoleUrl = `https://open.feishu.cn/app/${appId}`
    this.current = { phase: 'awaiting-secret', mode: 'bind', appId, consoleUrl }
    return { consoleUrl }
  }

  async finishBind(appSecret: string): Promise<void> {
    const secret = appSecret.trim()
    if (secret === '') {
      const error = new Error('appSecret 不能为空')
      this.current = { phase: 'failed', error: error.message }
      throw error
    }
    const current = this.current
    if (current.phase !== 'awaiting-secret') {
      const error = new Error('当前不在绑定流程，请先调用 startBind')
      this.current = { phase: 'failed', error: error.message }
      throw error
    }
    try {
      await this.options.settingsWrite({ appId: current.appId, appSecret: secret })
      this.current = { phase: 'done', appId: current.appId, needsSecretPaste: false }
      this.log('info', 'dsh-lark-inbox: 已绑定飞书应用并写入凭据')
    } catch (error) {
      this.current = { phase: 'failed', error: redactSecrets(error instanceof Error ? error.message : String(error)) }
      throw error
    }
  }

  async cancel(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (child) { try { child.kill('SIGTERM') } catch { /* already exited */ } }
    this.current = { phase: 'idle' }
  }

  private generateQr(url: string): Promise<boolean> {
    return new Promise(resolve => {
      const child = this.spawn(this.cli, ['auth', 'qrcode', url, '--output', 'qr.png'], { stdio: ['ignore', 'ignore', 'ignore'], cwd: this.qrDir, shell: false })
      child.on('error', () => resolve(false))
      child.on('exit', code => resolve(code === 0))
    })
  }

  private async completeInit(code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string): Promise<void> {
    if (signal) return
    if (code !== 0) {
      const tail = stderr.trim() === '' ? `lark-cli config init 退出码 ${code ?? 'null'}` : stderr.slice(-400)
      this.current = { phase: 'failed', error: redactSecrets(tail) }
      return
    }
    try {
      const appId = await this.configShowAppId()
      const secret = extractOneTimeSecret(stdout)
      if (secret !== undefined) {
        await this.options.settingsWrite({ appId, appSecret: secret })
        this.current = { phase: 'done', appId, needsSecretPaste: false }
        this.log('info', 'dsh-lark-inbox: 已创建飞书应用并写入凭据')
      } else {
        await this.options.settingsWrite({ appId })
        this.current = { phase: 'done', appId, needsSecretPaste: true }
        this.log('info', 'dsh-lark-inbox: 已写入 appId，仍需粘贴 appSecret')
      }
    } catch (error) {
      this.current = { phase: 'failed', error: redactSecrets(error instanceof Error ? error.message : String(error)) }
    }
  }

  private configShowAppId(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.cli, ['config', 'show'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: this.qrDir, shell: false })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', chunk => { stdout += String(chunk) })
      child.stderr?.on('data', chunk => { stderr += String(chunk) })
      child.on('error', (error: NodeJS.ErrnoException) => reject(new Error(redactSecrets(error.code === 'ENOENT' ? INSTALL_HINT : error.message))))
      child.on('exit', code => {
        if (code !== 0) { reject(new Error(redactSecrets(stderr.trim() === '' ? `lark-cli config show 退出码 ${code ?? 'null'}` : stderr.slice(-400)))); return }
        try {
          const parsed = JSON.parse(stdout) as { appId?: unknown }
          if (typeof parsed.appId === 'string' && parsed.appId !== '') { resolve(parsed.appId); return }
        } catch { /* regex fallback */ }
        const match = /"appId"\s*:\s*"([^"]+)"/.exec(stdout)
        match ? resolve(match[1]) : reject(new Error('lark-cli config show 未返回 appId'))
      })
    })
  }
}
