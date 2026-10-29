/** Official Lark SDK WebSocket long-connection gateway. */

import { Domain, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk'

export type LarkDomain = 'feishu' | 'lark'
type EventHandler = (data: unknown) => void

export interface GatewaySdk {
  domain: { Feishu: unknown; Lark: unknown }
  createDispatcher(): { register(handlers: Record<string, EventHandler>): unknown }
  createClient(options: { appId: string; appSecret: string; domain: unknown; wsConfig: { pingTimeout: number } }): {
    start(options: { eventDispatcher: unknown }): Promise<unknown>
    close(): unknown
  }
}

const officialSdk: GatewaySdk = {
  domain: Domain,
  createDispatcher: () => new EventDispatcher({}),
  createClient: options => new WSClient(options as ConstructorParameters<typeof WSClient>[0]),
}

export interface GatewayOptions {
  appId: string
  appSecret: string
  domain?: LarkDomain
  onEvent(event: unknown, meta: { mentionBot: boolean }): void
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  sdk?: GatewaySdk
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function mentionEntryToId(entry: unknown): string {
  if (!isRecord(entry)) return ''
  const id = entry.id
  if (typeof id === 'string') return nonEmpty(id)
  if (isRecord(id)) {
    for (const key of ['open_id', 'user_id', 'union_id', 'id']) {
      const value = nonEmpty(id[key])
      if (value) return value
    }
  }
  const userId = entry.user_id
  if (typeof userId === 'string') return nonEmpty(userId)
  if (isRecord(userId)) {
    for (const key of ['open_id', 'user_id', 'union_id']) {
      const value = nonEmpty(userId[key])
      if (value) return value
    }
  }
  return nonEmpty(entry.key)
}

function locateMentions(event: unknown): unknown {
  if (!isRecord(event)) return undefined
  if (isRecord(event.message) && Array.isArray(event.message.mentions)) return event.message.mentions
  if (isRecord(event.event)) {
    if (isRecord(event.event.message) && Array.isArray(event.event.message.mentions)) return event.event.message.mentions
    if (Array.isArray(event.event.mentions)) return event.event.mentions
  }
  return Array.isArray(event.mentions) ? event.mentions : undefined
}

export function extractMentionIds(event: unknown): string[] {
  const mentions = locateMentions(event)
  if (!Array.isArray(mentions)) return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const entry of mentions) {
    const id = mentionEntryToId(entry)
    if (id && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

/** Old-fleet degraded behavior: any mention counts while bot open-id is unavailable. */
export function isBotMentioned(event: unknown): boolean {
  return extractMentionIds(event).length > 0
}

export class LarkGateway {
  private readonly options: GatewayOptions
  private readonly sdk: GatewaySdk
  private readonly log: NonNullable<GatewayOptions['log']>
  private client: ReturnType<GatewaySdk['createClient']> | undefined
  private running = false
  private generation = 0

  constructor(options: GatewayOptions) {
    this.options = options
    this.sdk = options.sdk ?? officialSdk
    this.log = options.log ?? (() => undefined)
  }

  isRunning(): boolean {
    return this.running
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    const generation = ++this.generation
    let acquired: ReturnType<GatewaySdk['createClient']> | undefined
    try {
      const domain = this.options.domain ?? 'feishu'
      const sdkDomain = domain === 'feishu' ? this.sdk.domain.Feishu
        : domain === 'lark' ? this.sdk.domain.Lark
          : undefined
      if (sdkDomain === undefined) throw new Error(`lark-inbox: unsupported domain '${domain}' — the installed @larksuiteoapi/node-sdk only maps 'feishu' and 'lark'`)
      const client = this.sdk.createClient({
        appId: this.options.appId,
        appSecret: this.options.appSecret,
        domain: sdkDomain,
        wsConfig: { pingTimeout: 3 },
      })
      acquired = client
      const eventDispatcher = this.sdk.createDispatcher().register({
        'im.message.receive_v1': data => {
          if (generation === this.generation && this.running) this.dispatch(data)
        },
      })
      await client.start({ eventDispatcher })
      // stop() may have run while the SDK was connecting. Do not publish a
      // late client after rollback, or let an old start overwrite a newer one.
      if (generation !== this.generation || !this.running) {
        client.close()
        return
      }
      this.client = client
      this.log('info', 'lark-inbox gateway started (subscribed: im.message.receive_v1)')
    } catch (error) {
      try { acquired?.close() } catch (closeError) { this.log('error', `lark-inbox gateway cleanup failed: ${describeError(closeError)}`) }
      if (generation === this.generation) this.running = false
      this.log('error', `lark-inbox gateway start failed: ${describeError(error)}`)
      throw error
    }
  }

  async stop(): Promise<void> {
    ++this.generation
    const client = this.client
    if (!client) {
      this.running = false
      return
    }
    try {
      client.close()
    } catch (error) {
      this.log('error', `lark-inbox gateway stop failed: ${describeError(error)}`)
      throw error
    }
    this.client = undefined
    this.running = false
    this.log('info', 'lark-inbox gateway stopped')
  }

  private dispatch(data: unknown): void {
    let mentionBot = false
    try {
      mentionBot = isBotMentioned(data)
    } catch (error) {
      this.log('error', `lark-inbox mention detection failed: ${describeError(error)}`)
    }
    try {
      this.options.onEvent(data, { mentionBot })
    } catch (error) {
      this.log('error', `lark-inbox onEvent handler failed: ${describeError(error)}`)
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
