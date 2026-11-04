/**
 * Official Lark SDK WebSocket long-connection gateway.
 *
 * Four properties of this layer are load-bearing:
 *
 * 1. A message that cannot be stored must make the SDK answer the platform with
 *    an error, so Feishu redelivers it. The SDK propagates a handler's rejection
 *    into `code = 500` on the ACK frame, but only if nobody swallows it on the
 *    way. So `dispatch` throws the storage failure outward and the handler
 *    returns it; the only failures handled here are the ones that mean "this
 *    event will never be usable" (an uninspectable payload) or "this event
 *    belongs to a connection that was already replaced".
 * 2. `start()` resolving does not mean the socket is connected — the SDK returns
 *    from `start()` before the handshake finishes. Connection health is
 *    therefore reported from the SDK's own lifecycle callbacks, and a dispatch
 *    that arrives is itself proof of life.
 * 3. "Mentions somebody" is not "mentions this bot". The comparison needs the
 *    bot's own open id, which is learned from the platform once at startup; when
 *    it is unknown, no group message can be proven to address us.
 * 4. A stale connection's events are dropped, and dropping them is not a
 *    failure: the replacement connection received them from the platform again.
 */

import { Client, Domain, EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk'
import { mentionsBot } from '../../../core/lark-inbox/gating.ts'

export type LarkDomain = 'feishu' | 'lark'

/** Handler return values the SDK understands: the resolved value is echoed to the platform. */
type EventHandler = (data: unknown) => void | Promise<void>

/** Connection health as the host reports it to whoever asks "is the bot listening". */
export type GatewayStatus = 'connecting' | 'connected' | 'error'

export interface GatewayHealth {
  status: GatewayStatus
  /** Last transport error, kept until the next successful connection. */
  error?: string
}

/** The subset of the platform client needed to learn the bot's own identity. */
export interface GatewayApiClient {
  /** The bot's own open id (`GET /open-apis/bot/v3/info` -> `bot.open_id`). */
  botOpenId(): Promise<string>
}

export interface GatewayClientOptions {
  appId: string
  appSecret: string
  domain: unknown
  wsConfig: { pingTimeout: number }
  /** Fires once, when the first WebSocket handshake succeeds. */
  onReady?: () => void
  /** Fires when the platform connection is given up on, with the reason. */
  onError?: (error: Error) => void
  /** Fires when the SDK enters its reconnect loop. */
  onReconnecting?: () => void
  /** Fires once the reconnect loop re-established the connection. */
  onReconnected?: () => void
}

export interface GatewaySdk {
  domain: { Feishu: unknown; Lark: unknown }
  createDispatcher(): { register(handlers: Record<string, EventHandler>): unknown }
  createClient(options: GatewayClientOptions): {
    start(options: { eventDispatcher: unknown }): Promise<unknown>
    close(): unknown
  }
  /** Builds the REST client used once at startup to learn the bot's own open id. */
  createApiClient(options: { appId: string; appSecret: string; domain: unknown }): GatewayApiClient
}

const officialSdk: GatewaySdk = {
  domain: Domain,
  createDispatcher: () => new EventDispatcher({}),
  createClient: options => new WSClient(options as unknown as ConstructorParameters<typeof WSClient>[0]),
  createApiClient: options => {
    // Feishu's REST client resolves business errors instead of rejecting, so the
    // envelope decides; `bot` is absent on a failure envelope.
    const client = new Client(options as ConstructorParameters<typeof Client>[0])
    return {
      async botOpenId(): Promise<string> {
        const response = await client.request<{ code?: number; msg?: string; bot?: { open_id?: string } }>(
          { method: 'GET', url: '/open-apis/bot/v3/info' },
        )
        const openId = typeof response?.bot?.open_id === 'string' ? response.bot.open_id.trim() : ''
        if (openId !== '') return openId
        const code = typeof response?.code === 'number' ? response.code : undefined
        const message = typeof response?.msg === 'string' ? response.msg : ''
        throw new Error(`lark-inbox: bot/v3/info returned no open_id${code === undefined ? '' : ` (code ${code}${message === '' ? '' : `: ${message}`})`}`)
      },
    }
  },
}

export interface GatewayOptions {
  appId: string
  appSecret: string
  domain?: LarkDomain
  /**
   * Deliver one event. `mentionBot` is true only when the event mentions this
   * bot's own open id; `botOpenId` is empty when the identity could not be
   * learned, which admission treats as "cannot prove this addresses us".
   */
  onEvent(event: unknown, meta: { mentionBot: boolean; botOpenId?: string }): void
  /** Connection health transitions, wired to the peek tool's `gateway` field. */
  onStatus?(health: GatewayHealth): void
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

function mentionIds(event: unknown, pick: (entry: Record<string, unknown>) => string): string[] {
  const mentions = locateMentions(event)
  if (!Array.isArray(mentions)) return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const entry of mentions) {
    if (!isRecord(entry)) continue
    const id = pick(entry)
    if (id && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

/**
 * Every id a message's mentions carry, most specific first.
 * @param event - the raw platform event.
 * @returns distinct ids in event order.
 */
export function extractMentionIds(event: unknown): string[] {
  return mentionIds(event, mentionEntryToId)
}

/**
 * Only the `mentions[].id.open_id` values.
 *
 * The bot's identity is an open id, so matching has to use the same namespace:
 * a mention that only carries a user id is not evidence that this bot was named.
 * @param event - the raw platform event.
 * @returns distinct open ids in event order.
 */
export function extractMentionOpenIds(event: unknown): string[] {
  return mentionIds(event, entry => {
    const id = entry.id
    return isRecord(id) ? nonEmpty(id.open_id) : typeof id === 'string' ? nonEmpty(id).startsWith('ou_') ? nonEmpty(id) : '' : ''
  })
}

/**
 * Whether an event mentions this bot.
 * @param event - the raw platform event.
 * @param botOpenId - the bot's own open id; empty when it was never learned.
 * @returns true only when the identity is known and present in the mentions.
 */
export function isBotMentioned(event: unknown, botOpenId: string | undefined): boolean {
  return mentionsBot(extractMentionOpenIds(event), botOpenId)
}

export class LarkGateway {
  private readonly options: GatewayOptions
  private readonly sdk: GatewaySdk
  private readonly log: NonNullable<GatewayOptions['log']>
  private client: ReturnType<GatewaySdk['createClient']> | undefined
  private running = false
  private generation = 0
  private botOpenId = ''
  private health: GatewayHealth = { status: 'connecting' }

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
    this.setHealth({ status: 'connecting' })
    let acquired: ReturnType<GatewaySdk['createClient']> | undefined
    try {
      const sdkDomain = this.resolveDomain()
      // Learn our own identity before the socket exists. Group admission depends
      // on it, and a message arriving before it is known would be refused as
      // unprovable; one REST call at startup is cheaper than losing messages.
      this.botOpenId = await this.resolveBotOpenId(sdkDomain)
      if (generation !== this.generation || !this.running) return
      const client = this.sdk.createClient({
        appId: this.options.appId,
        appSecret: this.options.appSecret,
        domain: sdkDomain,
        wsConfig: { pingTimeout: 3 },
        onReady: () => { if (generation === this.generation) this.setHealth({ status: 'connected' }) },
        onError: (error: Error) => {
          if (generation !== this.generation) return
          this.setHealth({ status: 'error', error: describeError(error) })
        },
        onReconnecting: () => { if (generation === this.generation) this.setHealth({ status: 'connecting' }) },
        onReconnected: () => { if (generation === this.generation) this.setHealth({ status: 'connected' }) },
      })
      acquired = client
      const eventDispatcher = this.sdk.createDispatcher().register({
        // Return the dispatch result on purpose: a rejected call is how the SDK
        // learns to answer `code = 500`, which is what makes Feishu redeliver.
        'im.message.receive_v1': data => {
          if (generation !== this.generation || !this.running) return
          return this.dispatch(data)
        },
      })
      await client.start({ eventDispatcher })
      // stop() may have run while the SDK was connecting. Do not publish a late
      // client after rollback, or let an old start overwrite a newer one.
      if (generation !== this.generation || !this.running) {
        client.close()
        return
      }
      this.client = client
      this.log('info', 'lark-inbox gateway started (subscribed: im.message.receive_v1)')
    } catch (error) {
      try { acquired?.close() } catch (closeError) { this.log('error', `lark-inbox gateway cleanup failed: ${describeError(closeError)}`) }
      if (generation === this.generation) {
        this.running = false
        this.setHealth({ status: 'error', error: describeError(error) })
      }
      this.log('error', `lark-inbox gateway start failed: ${describeError(error)}`)
      throw error
    }
  }

  async stop(): Promise<void> {
    ++this.generation
    // try/finally: a client whose close() throws must still leave this gateway
    // in a state a later start() can use, or the bot stays dead until restart.
    try {
      const client = this.client
      if (!client) return
      client.close()
    } finally {
      this.client = undefined
      this.running = false
      this.botOpenId = ''
      this.setHealth({ status: 'connecting' })
    }
  }

  private resolveDomain(): unknown {
    const domain = this.options.domain ?? 'feishu'
    const sdkDomain = domain === 'feishu' ? this.sdk.domain.Feishu
      : domain === 'lark' ? this.sdk.domain.Lark
        : undefined
    if (sdkDomain === undefined) throw new Error(`lark-inbox: unsupported domain '${domain}' — the installed @larksuiteoapi/node-sdk only maps 'feishu' and 'lark'`)
    return sdkDomain
  }

  /**
   * Ask the platform which bot this application is.
   *
   * Never throws: an unreachable API must not stop the socket from connecting —
   * direct messages keep working — but it is reported once, and group messages
   * are refused until an identity is known.
   * @param sdkDomain - the resolved SDK domain for the configured deployment.
   * @returns the bot's own open id, or '' when the platform could not say.
   */
  private async resolveBotOpenId(sdkDomain: unknown): Promise<string> {
    try {
      const api = this.sdk.createApiClient({ appId: this.options.appId, appSecret: this.options.appSecret, domain: sdkDomain })
      const openId = (await api.botOpenId()).trim()
      if (openId === '') throw new Error('bot identity API returned an empty open_id')
      this.log('info', `lark-inbox bot identity: ${openId}`)
      return openId
    } catch (error) {
      this.log('warn', `lark-inbox 未能取得 bot 自身 open_id（群消息将不予接受直到取得）：${describeError(error)}`)
      return ''
    }
  }

  private setHealth(health: GatewayHealth): void {
    this.health = health
    try { this.options.onStatus?.(health) } catch (error) { this.log('error', `lark-inbox status callback failed: ${describeError(error)}`) }
  }

  /**
   * Hand one event to the host.
   *
   * Locally handled failure: an uninspectable payload is treated as "mentions
   * nobody" and still delivered, because its body may be perfectly readable.
   * Everything else is the receiver's business — notably a queue write failure,
   * which must propagate so the platform redelivers the message.
   */
  private dispatch(data: unknown): void {
    let mentionBot = false
    try {
      mentionBot = isBotMentioned(data, this.botOpenId)
    } catch (error) {
      this.log('error', `lark-inbox mention detection failed: ${describeError(error)}`)
    }
    // An inbound message is proof the socket works, whatever the callbacks said.
    if (this.health.status !== 'connected') this.setHealth({ status: 'connected' })
    this.options.onEvent(data, { mentionBot, botOpenId: this.botOpenId })
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}