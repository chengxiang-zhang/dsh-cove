/**
 * The answer path: turn one stored Feishu message into one agent turn and one reply.
 *
 * Until this file existed, the inbound queue ended at `store.append`: nothing in
 * the repository ever drove a turn from a message, so a configured bot read
 * every message and answered none. This is that missing layer, and it is
 * deliberately the smallest one that can be trusted:
 *
 * 1. Serial per conversation. A chat gets one turn at a time, enforced by the
 *    ledger's partial unique index rather than by this loop remembering to wait.
 * 2. Never silent. Every admitted batch ends in exactly one reply: the model's
 *    text when there is one, a fixed sentence otherwise. A batch that cannot be
 *    answered is retired as `failed`, not dropped.
 * 3. Never twice. The job id is derived from a message id and reused as both the
 *    prompt's request id and the platform's idempotency token, so a redelivery, a
 *    retry and a restart all collapse into the same answer.
 * 4. Recovery does not re-run a turn. A turn may already have executed tools with
 *    side effects; after a restart it is closed as an explained interruption
 *    instead of being replayed.
 *
 * The engine is reached through three narrow ports rather than through the
 * session services directly, so the whole state machine is exercisable with a
 * fake clock and a fake sender.
 */

import { clearBotSessions, isBotSession, markBotSession } from '../feishu/index.ts'
import type { LarkInboxEnvelope } from '../../../core/lark-inbox/queue.ts'
import {
  PROACTIVE_MAX_PER_HOUR,
  PROACTIVE_MIN_RUN_MS,
  PROACTIVE_QUIET_FROM_HOUR,
  PROACTIVE_QUIET_TO_HOUR,
} from './config.ts'
import {
  admitReply,
  assistantTextOf,
  clampReplyText,
  composePrompt,
  fallbackReplyText,
  replyJobId,
  replySessionId,
  type ReplyMode,
  type ReplyOutcome,
} from '../../../core/lark-inbox/reply-machine.ts'
import type { AutoReplyConfig } from './config.ts'
import type { InboxStore } from './inbox-store.ts'
import type { ReplyJob } from './reply-store.ts'

/** Longest body one Feishu text message carries; kept below the sender's own cap. */
export const REPLY_TEXT_LIMIT = 6000

/** How long a cancelled turn is given to report its own end before it is closed. */
export const TIMEOUT_GRACE_MS = 15_000

/** The platform's emoji key for the receipt; a plain smile reads as "seen". */
export const REPLY_RECEIPT_EMOJI = 'SMILE'

/** How long a sweep waits before assuming an in-flight send is not coming back. */
export const SEND_GRACE_MS = 30_000

/** Backoff once the fast attempts are spent but the failure still looks temporary. */
export const SEND_SLOW_RETRY_MS = 30 * 60_000

/**
 * How long a reply keeps trying before it is treated as undeliverable.
 *
 * Giving up is a real outcome and has to exist: a bot that retries a dead chat
 * forever is a bot that never forgets. A day is long enough that a bad afternoon
 * still ends with the person hearing back.
 */
export const SEND_GIVE_UP_MS = 24 * 3_600_000

/** What the model says when an unprompted message is not worth sending. */
export const SILENT_REPLY_TOKEN = 'SILENT'

/** Marker written to `last_error` while a cancelled turn's end is still expected. */
const TIMEOUT_MARKER = 'timeout-requested'

/** A send result, as the reply path needs it. */
export interface ReplySendResult {
  readonly ok: boolean
  readonly error?: string
  readonly messageId?: string
  readonly retryable?: boolean
}

/** The one way this file talks to Feishu. */
export interface ReplySendPort {
  send(
    to: string,
    text: string,
    target?: { replyToMessageId?: string; idempotencyKey?: string },
  ): Promise<ReplySendResult>
  /**
   * Best-effort receipt on the message being answered. A port that returns a
   * promise is awaited only for its rejection to be swallowed; nothing the answer
   * path needs depends on it.
   */
  react?(messageId: string, emojiType: string): Promise<boolean>
}

/** The three engine capabilities the answer path needs. */
export interface ReplyEnginePorts {
  /** Create the session with this exact id, or adopt the one that exists. */
  ensureSession(input: { sessionId: string; cwd: string }): Promise<void>
  /** Ask for one user turn. Resolves when the engine has accepted it. */
  prompt(input: { requestId: string; sessionId: string; text: string }): Promise<void>
  /** Cancel whatever runs in a session; a no-op when nothing does. */
  cancel(sessionId: string): void
}

/** Everything the responder may touch, injected so tests can fake it. */
export interface ResponderPorts {
  readonly engine: ReplyEnginePorts
  readonly sender: () => ReplySendPort | undefined
  readonly config: () => AutoReplyConfig
  readonly now: () => number
  readonly log: {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }
  /** Timer seam; omitted means the owner drives {@link ReplyResponder.tick}. */
  readonly setInterval?: (run: () => void, ms: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
  /**
   * Somewhere outside the process to say "the answer path is alive".
   *
   * Without it, "is the responder mounted" is an inference - the tables exist, so
   * something ran once - and an inference is what let a dead answer path look
   * healthy for an hour. Best-effort: a failed write must not stop a sweep.
   */
  readonly heartbeat?: (state: ResponderHeartbeat) => void
}

/** What the answer path writes down about itself, for readers outside the process. */
export interface ResponderHeartbeat {
  /** Epoch milliseconds when this responder started. */
  readonly startedAt: number
  /** Epoch milliseconds of the most recent sweep. */
  readonly sweptAt: number
  readonly mode: ReplyMode
  readonly answered: number
  readonly open: number
  readonly failed: number
}

/** How often the heartbeat is refreshed at most, to keep a 2s sweep off the disk. */
export const HEARTBEAT_INTERVAL_MS = 30_000

/** What the operator-facing status reports. */
export interface ResponderStatus {
  readonly mode: ReplyMode
  readonly answered: number
  readonly open: number
  readonly failed: number
}

/** Where a session's current turn number is kept while its batch is running. */
interface TurnCursor {
  readonly turn: number
  readonly at: number
}

/**
 * Owns the transition from a stored message to a delivered answer.
 *
 * One instance per running gateway: it is built with the store, disposed with
 * it, and holds no state that a restart cannot rebuild from the ledger.
 */
export class ReplyResponder {
  private readonly store: InboxStore
  private readonly ports: ResponderPorts
  /** Serialises the advance loop: one sweep at a time per process. */
  private sweeping = false
  /** Set while a sweep is requested but not yet started, so a burst is one sweep. */
  private sweepQueued = false
  private timer: unknown
  private disposed = false
  private readonly startedAt = Date.now()
  private lastHeartbeatAt = Number.NEGATIVE_INFINITY
  /** Turn numbers seen per session, used to attribute a batch to its turn. */
  private readonly turnCursor = new Map<string, TurnCursor>()
  /** When each session's current turn opened, so a run's length is measurable. */
  private readonly turnStartedAt = new Map<string, number>()
  /** Assistant text per job, filled as messages arrive and consumed at turn end. */
  private readonly drafts = new Map<string, string>()

  constructor(store: InboxStore, ports: ResponderPorts) {
    this.store = store
    this.ports = ports
  }

  /**
   * Resolve whatever a previous process left mid-flight, then start sweeping.
   *
   * Recovery runs before the first sweep because a `running` job from the last
   * process holds its conversation's only turn slot; without this the chat would
   * stay mute for a job that no longer exists.
   */
  start(): void {
    try {
      // Claim the sessions this ledger already bound before the first sweep: a
      // notice for an answer-path session would duplicate the answer itself, and
      // the notification path must be told before that session can run again.
      for (const sessionId of this.store.reply.sessionIds()) markBotSession(sessionId)
    } catch (error) {
      this.ports.log.warn(`lark-inbox: 登记回话会话失败：${describeError(error)}`)
    }
    try {
      const recovered = this.store.reply.recoverInflight(this.ports.now(), 50 * 60_000)
      if (recovered.interrupted > 0 || recovered.resendable > 0 || recovered.uncertain > 0) {
        this.ports.log.warn(
          `lark-inbox: 恢复未完成的回话作业 中断=${recovered.interrupted} 待重发=${recovered.resendable} 不确定=${recovered.uncertain}`,
        )
      }
    } catch (error) {
      this.ports.log.error(`lark-inbox: 恢复回话作业失败：${describeError(error)}`)
    }
    this.adoptUnattached()
    const interval = this.ports.setInterval
    if (interval !== undefined) {
      this.timer = interval(() => { this.tick() }, this.ports.config().tickMs)
    }
    this.beat(true)
    this.requestSweep()
  }

  /**
   * Write down that this responder exists, throttled.
   * @param force - write regardless of the throttle, for start and for settles.
   */
  private beat(force = false): void {
    const sink = this.ports.heartbeat
    if (sink === undefined) return
    const now = this.ports.now()
    if (!force && now - this.lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return
    this.lastHeartbeatAt = now
    try {
      sink({
        startedAt: this.startedAt,
        sweptAt: now,
        mode: this.ports.config().mode,
        answered: this.ports.config().mode === 'off' ? 0 : this.store.reply.answeredCount(),
        open: this.store.reply.stats().collecting + this.store.reply.stats().submitting + this.store.reply.stats().running + this.store.reply.stats().replying,
        failed: this.store.reply.stats().failed,
      })
    } catch (error) {
      this.ports.log.warn(`lark-inbox: 心跳写入失败：${describeError(error)}`)
    }
  }

  /**
   * Take ownership of messages a previous process stored but never attached.
   *
   * The store and the ledger are separate writes, so a crash - or a failure in the
   * gap - leaves a message that is durable, deduplicated and owned by nothing.
   * Redelivery cannot heal it: the platform's copy is dropped as a duplicate before
   * admission runs again. Without this scan the message is lost forever, silently,
   * with a row in the queue that looks like work somebody will get to.
   *
   * Bounded on both axes: only recent messages (an outage window, not an archive)
   * and only a handful, because answering a day of backlog is not a recovery.
   */
  private adoptUnattached(): void {
    const limit = 5
    const within = 3_600_000
    let adopted = 0
    try {
      for (const envelope of this.store.unattachedPending(limit)) {
        const received = Date.parse(envelope.receivedAt)
        if (Number.isFinite(received) && this.ports.now() - received > within) continue
        this.admit(envelope)
        adopted += 1
      }
    } catch (error) {
      this.ports.log.warn(`lark-inbox: 接管遗留消息失败：${describeError(error)}`)
    }
    if (adopted > 0) {
      this.ports.log.warn(`lark-inbox: 接管了 ${adopted} 条上次进程未接管的入站消息`)
    }
  }

  /**
   * Admit one stored message to the answer path.
   *
   * Called after `store.append` succeeded and deliberately does not throw: the
   * message is already durable, so an error here must not become a non-200 ACK
   * that makes the platform redeliver a message this host already holds.
   * @param envelope - the stored message.
   */
  kick(envelope: LarkInboxEnvelope): void {
    if (this.disposed) return
    try {
      this.admit(envelope)
    } catch (error) {
      this.ports.log.error(`lark-inbox: 回话准入失败（消息已入队，未丢失）：${describeError(error)}`)
    }
  }

  /**
   * React to one session event.
   *
   * Only sessions this domain created are considered; the check is a ledger read
   * rather than an in-memory set so a restart cannot adopt a session it forgot.
   * @param sessionId - the session the event belongs to.
   * @param event - the engine event, shape-unchecked because it crosses a plugin boundary.
   */
  handleSessionEvent(sessionId: string, event: unknown): void {
    if (this.disposed) return
    try {
      this.onSessionEvent(sessionId, event)
    } catch (error) {
      this.ports.log.error(`lark-inbox: 处理会话事件失败：${describeError(error)}`)
    }
  }

  /**
   * Run one sweep: submit due batches, close timed-out turns, retry failed sends.
   *
   * Exposed because the timer seam is optional: a deployment (or a test) that
   * drives time itself calls this instead of waiting for an interval.
   */
  tick(): void {
    if (this.disposed) return
    try {
      this.sweep()
    } catch (error) {
      this.ports.log.error(`lark-inbox: 回话推进失败：${describeError(error)}`)
    }
  }

  /**
   * Stop the timer and refuse further work.
   *
   * The ledger is not touched: in-flight jobs are resolved by the next process's
   * `start()`, which is the only place that can know how long they sat.
   */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined && this.ports.clearInterval !== undefined) {
      this.ports.clearInterval(this.timer)
      this.timer = undefined
    }
    this.turnCursor.clear()
    this.drafts.clear()
    // A teardown puts these sessions back among ordinary ones. On a
    // settings-driven rebuild the replacement re-registers them in `start()`, so
    // clearing here cannot leave an answer-path session unmarked.
    clearBotSessions()
  }

  /**
   * Report what the answer path is doing, for the acceptance readings.
   * @returns mode and the ledger counts that matter to a person.
   */
  status(): ResponderStatus {
    const stats = this.store.reply.stats()
    return {
      mode: this.ports.config().mode,
      answered: this.store.reply.answeredCount(),
      open: stats.collecting + stats.submitting + stats.running + stats.replying,
      failed: stats.failed,
    }
  }

  /**
   * Decide and record what happens to one message.
   * @param envelope - the stored message.
   */
  private admit(envelope: LarkInboxEnvelope): void {
    const config = this.ports.config()
    const now = this.ports.now()
    const chatId = (envelope.chatId ?? '').trim()
    if (chatId === '') {
      // Without a conversation there is nowhere to answer; the queue row stays
      // pending so a tool can still read it.
      return
    }
    const decision = admitReply(
      {
        chatType: envelope.chatType,
        senderOpenId: envelope.senderOpenId,
        mentionBot: envelope.mentionBot,
        text: envelope.content,
      },
      { mode: config.mode, openIds: config.openIds },
    )
    if (!decision.accept) {
      if (decision.reason !== 'disabled') {
        this.ports.log.info(`lark-inbox: 消息 ${envelope.eventId} 未进入自动回话：${decision.reason}`)
      }
      return
    }

    const convKey = chatId
    const binding = this.store.reply.binding(convKey)
    const sessionId = binding?.sessionId ?? replySessionId(convKey, 1)
    this.store.reply.ensureBinding({
      convKey,
      chatId,
      chatType: envelope.chatType === 'group' ? 'group' : 'p2p',
      sessionId,
      now,
    })

    if (decision.command === 'stop') {
      this.applyStop(convKey, now)
      return
    }
    if (decision.command === 'new') {
      this.applyNew(convKey, now)
      return
    }

    const messageId = (envelope.messageId ?? '').trim()
    if (messageId === '') {
      // The message id is the batch's identity and its idempotency token; without
      // it the answer could be delivered twice, so the message stays pending.
      this.ports.log.warn(`lark-inbox: 消息 ${envelope.eventId} 没有 message_id，未进入自动回话`)
      return
    }

    markBotSession(sessionId)
    const result = this.store.reply.attach({
      eventId: envelope.eventId,
      messageId,
      jobId: replyJobId(messageId, envelope.eventId),
      convKey,
      replyToMessageId: messageId,
      now,
      debounceMs: config.debounceMs,
    })
    if (result.attached) {
      // Accepted and stored: this is the moment "I have your message" becomes true,
      // and the moment a person is most likely to be wondering.
      this.sendReceipt(messageId)
      this.requestSweep()
    }
  }

  /**
   * Ask the running turn to stop, and drop whatever is still collecting.
   * @param convKey - conversation key.
   * @param now - current time.
   */
  private applyStop(convKey: string, now: number): void {
    this.store.reply.cancelCollectingFor(convKey, '用户要求停止', now)
    const stopped = this.store.reply.requestStop(convKey, now)
    if (stopped === undefined) {
      this.ports.log.info('lark-inbox: 收到停止指令，但没有正在进行的回话')
      return
    }
    // The turn's own `turn/end(aborted)` carries the outcome; cancelling here just
    // asks for it earlier. Closing the job now would race that event and might
    // replace a real answer that was already streaming.
    this.ports.engine.cancel(stopped.sessionId)
    this.requestSweep()
  }

  /**
   * Start a fresh session for a conversation.
   * @param convKey - conversation key.
   * @param now - current time.
   */
  private applyNew(convKey: string, now: number): void {
    this.store.reply.cancelCollectingFor(convKey, '用户要求开启新会话', now)
    const binding = this.store.reply.binding(convKey)
    const generation = (binding?.generation ?? 1) + 1
    const next = replySessionId(convKey, generation)
    this.store.reply.rotateBinding(convKey, next, now)
    // The replacement session answers this conversation too, so the notification
    // path has to know before the first turn runs in it - otherwise every turn
    // after a `/new` would also push a finished-run notice.
    markBotSession(next)
    this.ports.log.info(`lark-inbox: 会话 ${convKey} 已开启第 ${generation} 个会话`)
  }

  /** Ask for a sweep without stacking them. */
  private requestSweep(): void {
    if (this.disposed || this.sweepQueued) return
    this.sweepQueued = true
    // Deferred so a burst of appended messages becomes one sweep: the debounce
    // window decides when a batch is ready, not how often this loop runs.
    globalThis.setTimeout(() => {
      this.sweepQueued = false
      this.tick()
    }, 0)
  }

  /** One sweep, guarded so two cannot interleave. */
  private sweep(): void {
    if (this.sweeping) return
    this.sweeping = true
    try {
      const now = this.ports.now()
      this.beat()
      for (const job of this.store.reply.dueJobs(now)) {
        try {
          if (job.state === 'collecting') this.submit(job, now)
          else if (job.state === 'running') this.expire(job, now)
          else if (job.state === 'submitting') this.expireSubmit(job, now)
          else if (job.state === 'replying') void this.deliver(job, now)
        } catch (error) {
          // One poisoned job must not park every other conversation's work.
          this.ports.log.error(`lark-inbox: 推进 ${job.jobId} 失败：${describeError(error)}`)
        }
      }
    } finally {
      this.sweeping = false
    }
  }

  /**
   * Turn a ready batch into one prompt.
   * @param job - the batch, collecting or a submission to retry.
   * @param now - current time.
   */
  private submit(job: ReplyJob, now: number): void {
    const config = this.ports.config()
    if (job.state === 'collecting' && this.store.reply.inflightJob(job.convKey) !== undefined) return
    const binding = this.store.reply.binding(job.convKey)
    if (binding === undefined) {
      this.failBeforeRun(job, '会话绑定丢失', now)
      return
    }
    let text: string
    let carriesPreamble = false
    if (job.kind === 'proactive') {
      // No message to quote: the prompt has to describe what happened instead.
      text = this.proactivePrompt(now)
    } else {
      const messages = this.store.reply.messagesOf(job.jobId)
      if (messages.length === 0) {
        this.failBeforeRun(job, '批次内没有消息', now)
        return
      }
      const preamble = binding.preambleSent ? '' : config.preamble
      text = composePrompt(messages.map(message => message.text), preamble)
      carriesPreamble = preamble !== ''
    }
    if (!this.store.reply.claimSubmit(job.jobId, binding.sessionId, now, now + config.turnTimeoutMs)) return
    void this.submitAsync(job.jobId, binding.sessionId, binding.convKey, text, carriesPreamble)
  }

  /**
   * The async half of {@link submit}: create the session, ask for the turn.
   *
   * Kept separate so the sweep stays synchronous and cannot be re-entered by an
   * await; every failure is recorded on the job and surfaces as a reply.
   * @param jobId - the batch.
   * @param sessionId - its conversation's session.
   * @param convKey - conversation key.
   * @param text - the prompt content.
   * @param marksPreamble - whether this prompt carried the standing instructions.
   */
  private async submitAsync(
    jobId: string,
    sessionId: string,
    convKey: string,
    text: string,
    marksPreamble: boolean,
  ): Promise<void> {
    const config = this.ports.config()
    try {
      await this.ports.engine.ensureSession({ sessionId, cwd: config.cwd })
      // The bind can take arbitrarily long. If the job was closed while it hung - a
      // submit timeout, a stop - starting the turn now would run work for a request
      // the person was already told had failed.
      const live = this.store.reply.job(jobId)
      if (live === undefined || live.state !== 'submitting') {
        this.ports.log.warn(`lark-inbox: ${jobId} 建会话返回时作业已不在提交态（${live?.state ?? '已删除'}），放弃这一次回合`)
        return
      }
      // Marked running before the prompt is handed over, not after it returns:
      // the engine may open and finish the turn while this call is still pending,
      // and those events must find a running job or the answer is lost.
      this.store.reply.markRunning(jobId, this.ports.now() + config.turnTimeoutMs, this.ports.now())
      await this.ports.engine.prompt({ requestId: jobId, sessionId, text })
      // One line per submitted turn: without it the first live run leaves no trace
      // to read, and "no reply" is indistinguishable from "never submitted".
      this.ports.log.info(
        `lark-inbox: 已提交回话回合 job=${jobId} session=${sessionId} 字符=${text.length}${marksPreamble ? ' 含前言' : ''}`,
      )

      if (marksPreamble) this.store.reply.markPreambleSent(convKey, this.ports.now())
    } catch (error) {
      const detail = describeError(error)
      const attempts = (this.store.reply.job(jobId)?.submitAttempts ?? 0)
      if (attempts >= config.maxSubmitAttempts) {
        // Out of retries: close the job with a sentence rather than leaving the
        // person with no evidence anything happened.
        this.store.reply.finishTurn(jobId, 'error', fallbackReplyText('error', detail), 'submit-failed', this.ports.now())
        const job = this.store.reply.job(jobId)
        if (job !== undefined) void this.deliver(job, this.ports.now())
        return
      }
      const backoff = Math.min(30_000, 2 ** attempts * 1000)
      // A submitted-but-unbound job goes back to the batch; one that already bound
      // a turn is left to that turn's own end.
      if (!this.store.reply.revertRun(jobId, detail, this.ports.now() + backoff, this.ports.now())) {
        this.ports.log.warn(`lark-inbox: ${jobId} 提交失败且已绑定回合，等待回合自身结束：${detail}`)
      }
    }
  }

  /**
   * Mark one message as read with a reaction, if the operator asked for that.
   *
   * Fired when the message is accepted, not when its turn starts. A message that
   * arrives while another turn is running waits its turn in the queue, and that
   * wait is exactly when a person most needs to know they were heard - reacting at
   * submit time would stay silent for the whole queue.
   *
   * Fire-and-forget on purpose: a receipt that failed - a missing scope, a recalled
   * message, a rate limit - must cost a log line rather than the reply. Skipped in
   * probe mode, where the whole point is to touch nothing visible.
   * @param messageId - the message the person just sent.
   */
  private sendReceipt(messageId: string): void {
    const config = this.ports.config()
    if (!config.receipt || config.mode === 'probe') return
    const sender = this.ports.sender()
    if (sender?.react === undefined) return
    void sender.react(messageId, REPLY_RECEIPT_EMOJI).catch((error: unknown) => {
      this.ports.log.warn(`lark-inbox: 表情回执失败 message=${messageId}：${describeError(error)}`)
    })
  }

  /**
   * The prompt that asks the model whether to speak, and lets it decline.
   *
   * Written as a decision with an explicit way out. The alternative - asking it to
   * summarise the run - would produce a message every time, which is the behaviour
   * this whole path is bounded against.
   * @param now - current time, for the wording only.
   * @returns the prompt body.
   */
  private proactivePrompt(now: number): string {
    void now
    return [
      '这是一条自动提醒，不是有人在问你。',
      '你刚才在另一个会话里完成了一段比较长的工作。',
      '现在决定要不要主动告诉对方：',
      '- 如果对方确实需要现在就知道，就直接输出你要发给对方的那段纯文本。',
      `- 如果不需要打扰对方，就只输出 ${SILENT_REPLY_TOKEN} 这一行，不要有别的字。`,
      '- 不要调用任何工具，不要解释你在做什么。',
    ].join('\n')
  }

  /**
   * Fail a batch that never reached the engine, and say so.
   *
   * Retiring it silently is the one thing this path must not do: the person sent a
   * message and is waiting. Every pre-turn failure therefore ends in the same
   * sentence a failed turn does, through the same send.
   * @param job - the batch that cannot run.
   * @param detail - what went wrong, short enough to show.
   * @param now - current time.
   */
  private failBeforeRun(job: ReplyJob, detail: string, now: number): void {
    const text = fallbackReplyText('error', detail)
    if (!this.store.reply.failPreTurn(job.jobId, 'error', text, now)) return
    this.ports.log.warn(`lark-inbox: ${job.jobId} 未能开跑（${detail}），已回说明`)
    const closed = this.store.reply.job(job.jobId)
    if (closed !== undefined) void this.deliver(closed, now)
  }

  /**
   * Close a submission that never produced a turn.
   *
   * A pending engine call leaves the job in `submitting` with no bound turn. It is
   * retried while attempts remain, because nothing ran; when they are gone the
   * person gets a sentence instead of the silence a stuck job would otherwise
   * leave behind.
   * @param job - the stuck submission.
   * @param now - current time.
   */
  private expireSubmit(job: ReplyJob, now: number): void {
    const config = this.ports.config()
    if (job.submitAttempts >= config.maxSubmitAttempts) {
      const text = fallbackReplyText('error', job.lastError ?? '提交超时')
      if (!this.store.reply.failPreTurn(job.jobId, 'error', text, now)) return
      this.ports.log.warn(`lark-inbox: ${job.jobId} 提交 ${job.submitAttempts} 次仍无回合，已回说明`)
      const closed = this.store.reply.job(job.jobId)
      if (closed !== undefined) void this.deliver(closed, now)
      return
    }
    const backoff = Math.min(30_000, 2 ** job.submitAttempts * 1000)
    this.ports.log.warn(`lark-inbox: ${job.jobId} 提交超时，${Math.round(backoff / 1000)}s 后重试`)
    this.store.reply.revertRun(job.jobId, '提交超时：引擎未在时限内开出回合', now + backoff, now)
  }

  /**
   * Close a turn that outlived its deadline.
   *
   * Two phases: cancel, then wait one grace period for the engine's own
   * `turn/end(aborted)` so a turn that was about to finish still delivers its
   * text. Only a turn still running after the grace is closed as a timeout.
   * @param job - the running job.
   * @param now - current time.
   */
  private expire(job: ReplyJob, now: number): void {
    if (job.lastError === TIMEOUT_MARKER) {
      const ended = this.closeTurn(job, 'timeout', fallbackReplyText('timeout'))
      if (ended) this.ports.log.warn(`lark-inbox: ${job.jobId} 超时未收到回合结束，已按超时结案`)
      return
    }
    this.ports.log.warn(`lark-inbox: ${job.jobId} 超过 ${this.ports.config().turnTimeoutMs}ms，请求取消`)
    this.ports.engine.cancel(job.sessionId)
    this.store.reply.markTimeoutPending(job.jobId, TIMEOUT_MARKER, now + TIMEOUT_GRACE_MS, now)
  }

  /**
   * Send one finished job's body.
   * @param job - the job to deliver.
   * @param now - current time.
   */
  private async deliver(job: ReplyJob, now: number): Promise<void> {
    const config = this.ports.config()
    // An empty body is a bug in this file, not a reason to go quiet: the person is
    // still waiting for an answer to a message they sent.
    const body = (job.replyText ?? '').trim() === ''
      ? fallbackReplyText('error', '没有可发送的正文')
      : (job.replyText ?? '').trim()
    if (config.mode === 'probe') {
      // Probe mode exists so the seam can be read without speaking to a person:
      // the ledger records what would have been sent, and nothing leaves the host.
      this.store.reply.markSent(job.jobId, undefined, now)
      this.beat(true)
      this.ports.log.info(`lark-inbox: probe 模式，未发送 ${job.jobId}：${body.slice(0, 60)}`)
      return
    }
    const sender = this.ports.sender()
    if (sender === undefined) {
      this.store.reply.markSendFailed(job.jobId, '飞书应用凭据不可用', now)
      return
    }
    const binding = this.store.reply.binding(job.convKey)
    const chatId = binding?.chatId ?? job.convKey
    // Counted before the call, not after it fails: a reply that went out on the
    // first try is one attempt, and a ledger that says zero cannot be used to read
    // how much retrying an installation actually needed.
    const attempts = this.store.reply.bumpSendAttempt(job.jobId)
    // Claim the send before making it: a call that never returns must not be re-issued
    // by the next sweep, which is how one stuck send became six. The retry time is
    // pushed forward now and replaced by the real backoff if the call fails.
    this.store.reply.deferSend(job.jobId, job.lastError ?? '', this.ports.now() + SEND_GRACE_MS, this.ports.now())
    const attempt = await sender.send(chatId, body, {
      // An unprompted message has no message to answer; an empty id would send
      // `im.message.reply` with `message_id: ''` instead of starting a new message.
      ...(job.replyToMessageId === '' ? {} : { replyToMessageId: job.replyToMessageId }),
      idempotencyKey: job.jobId,
    })
    if (attempt.ok) {
      this.store.reply.markSent(job.jobId, attempt.messageId, this.ports.now())
      // Written here rather than when the turn closed: the outside reader should
      // see the answer land, not the moment its text became known.
      this.beat(true)
      return
    }
    const detail = attempt.error ?? '未知错误'
    if (attempt.retryable === true && attempts < config.maxSendAttempts) {
      // Same idempotency token on the retry, so the platform collapses a copy the
      // first attempt may have delivered before the error surfaced.
      this.store.reply.deferSend(job.jobId, detail, this.ports.now() + Math.min(30_000, 2 ** attempts * 1000), this.ports.now())
      return
    }
    if (attempt.retryable === true) {
      // Fast attempts are spent but the failure is still described as temporary - a
      // dead mobile network is the ordinary case. Falling to permanent silence here
      // would mean the person never hears back from a hiccup, so the retry slows down
      // instead of stopping, and stops only when the answer has clearly gone stale.
      const age = this.ports.now() - job.createdAt
      if (age < SEND_GIVE_UP_MS) {
        this.store.reply.deferSend(job.jobId, detail, this.ports.now() + SEND_SLOW_RETRY_MS, this.ports.now())
        this.ports.log.warn(`lark-inbox: 回复 ${job.jobId} 暂发不出（${detail}），${Math.round(SEND_SLOW_RETRY_MS / 60000)} 分钟后重试`)
        return
      }
      this.ports.log.error(`lark-inbox: 回复 ${job.jobId} 已尝试 ${Math.round(age / 3_600_000)} 小时仍发不出，放弃`)
    }
    this.store.reply.markSendFailed(job.jobId, detail, this.ports.now())
    this.beat(true)
    this.ports.log.error(`lark-inbox: 回复发送失败 ${job.jobId}：${detail}`)
  }

  /**
   * Record a turn's outcome and hand it to the send step.
   * @param job - the running job.
   * @param outcome - how it ended.
   * @param text - the body to send.
   * @param endReason - the engine's reason, kept for diagnosis.
   * @returns true when this call closed the turn.
   */
  /**
   * Close a proactive batch that decided not to speak.
   *
   * Recorded as `empty` rather than `cancelled`: the turn ran and made a choice, and
   * an operator reading the ledger needs to tell "chose silence" apart from "never
   * got the chance". This is the one path where silence is the delivered outcome.
   * @param job - the proactive job.
   * @param now - current time.
   * @returns true when this call closed it.
   */
  private closeSilently(job: ReplyJob, now: number): boolean {
    if (!this.store.reply.finishTurn(job.jobId, 'empty', '', 'silent', now, now + SEND_GRACE_MS)) return false
    this.drafts.delete(job.jobId)
    this.store.reply.markSent(job.jobId, undefined, now)
    this.ports.log.info(`lark-inbox: ${job.jobId} 决定不打扰，未发送`)
    this.beat(true)
    return true
  }

  private closeTurn(job: ReplyJob, outcome: ReplyOutcome, text: string, endReason = ''): boolean {
    const now = this.ports.now()
    const body = clampReplyText(text, REPLY_TEXT_LIMIT)
    // Claim the send before dropping the draft: a turn that was already closed by
    // another path must not leave its text pinned in memory for the process's
    // lifetime.
    this.drafts.delete(job.jobId)
    if (!this.store.reply.finishTurn(job.jobId, outcome, body, endReason, now, now + SEND_GRACE_MS)) return false
    this.ports.log.info(
      `lark-inbox: 回合结案 job=${job.jobId} outcome=${outcome} 原因=${endReason === '' ? '-' : endReason} 字符=${body.length}`,
    )
    const closed = this.store.reply.job(job.jobId)
    if (closed !== undefined) void this.deliver(closed, now)
    return true
  }

  /**
   * Track one session event and close a turn when it ends.
   * @param sessionId - the session.
   * @param event - the engine event.
   */
  private onSessionEvent(sessionId: string, event: unknown): void {
    const record = typeof event === 'object' && event !== null ? event as Record<string, unknown> : {}
    const type = typeof record.type === 'string' ? record.type : ''
    const data = typeof record.data === 'object' && record.data !== null ? record.data as Record<string, unknown> : {}
    if (!isBotSession(sessionId)) {
      // A session that answers Feishu is this file's own; every other session is
      // the person working somewhere else, which is what a notice may be about.
      this.observeForeignTurn(sessionId, type, data)
      return
    }
    const running = this.store.reply.runningJobForSession(sessionId)
    if (running === undefined) {
      // The job may already be closed (a timeout that the turn's own end reached
      // late). Forget the turn number anyway, so nothing can rebind a later batch
      // to a turn that ended.
      const data = typeof event === 'object' && event !== null ? event as Record<string, unknown> : {}
      if (data.type === 'turn/end') this.turnCursor.delete(sessionId)
      return
    }

    if (type === 'turn/start') {
      const turn = typeof data.turn === 'number' ? data.turn : undefined
      if (turn !== undefined) this.turnCursor.set(sessionId, { turn, at: this.ports.now() })
      return
    }

    if (type === 'user/message') {
      // The prompt's own message is the only reliable link between a turn and the
      // job that asked for it: binding on `turn/start` alone would also catch a
      // turn a human started by typing into this session in the Web UI.
      const source = typeof data.source === 'object' && data.source !== null ? data.source as Record<string, unknown> : {}
      const rpcId = typeof source.rpcId === 'string' ? source.rpcId : ''
      if (rpcId === '' || rpcId !== running.jobId) return
      const cursor = this.turnCursor.get(sessionId)
      if (cursor !== undefined) this.store.reply.bindTurn(running.jobId, cursor.turn, this.ports.now())
      return
    }

    if (type === 'assistant/message') {
      const turn = typeof data.turn === 'number' ? data.turn : undefined
      if (turn === undefined || running.turn === undefined || turn !== running.turn) return
      // An interrupted message is a half-stream the reader should not be shown as
      // if it were the answer; the turn's own outcome decides what is sent.
      if (data.interrupted === true) return
      const message = typeof data.message === 'object' && data.message !== null ? data.message as Record<string, unknown> : undefined
      const text = assistantTextOf(message?.content ?? data.content)
      if (text !== '') this.drafts.set(running.jobId, text)
      return
    }

    if (type !== 'turn/end') return
    const turn = typeof data.turn === 'number' ? data.turn : undefined
    if (turn === undefined || running.turn === undefined || turn !== running.turn) return
    this.turnCursor.delete(sessionId)
    this.settleTurn(running, data)
  }

  /**
   * Watch a run in someone else's session, and consider saying something about it.
   *
   * Three gates, cheapest first: the run must be long enough to have done something
   * worth reporting, the hour must be one a person would accept a message in, and
   * the conversation must be under its hourly budget. Only then does a turn run to
   * decide whether to actually speak - the model decides, the gates only decide
   * whether it gets asked.
   * @param sessionId - the session that ran.
   * @param type - event type.
   * @param data - event payload.
   */
  private observeForeignTurn(sessionId: string, type: string, data: Record<string, unknown>): void {
    const now = this.ports.now()
    if (type === 'turn/start') {
      const turn = typeof data.turn === 'number' ? data.turn : undefined
      this.turnStartedAt.set(sessionId, now)
      void turn
      return
    }
    if (type !== 'turn/end') return
    const startedAt = this.turnStartedAt.get(sessionId)
    this.turnStartedAt.delete(sessionId)
    const turn = typeof data.turn === 'number' ? data.turn : -1
    const reason = typeof data.reason === 'object' && data.reason !== null ? data.reason as Record<string, unknown> : {}
    if (reason.kind !== 'completed') return
    if (startedAt === undefined || now - startedAt < PROACTIVE_MIN_RUN_MS) return

    const config = this.ports.config()
    if (!config.proactive) return
    const hour = new Date(now).getHours()
    const quiet = hour >= PROACTIVE_QUIET_FROM_HOUR || hour < PROACTIVE_QUIET_TO_HOUR
    if (quiet) {
      this.ports.log.info(`lark-inbox: 静默时段（${hour} 点），跳过主动通知 session=${sessionId}`)
      return
    }
    const target = this.store.reply.latestDirectBinding()
    if (target === undefined) {
      // Nobody has ever written to this bot, so there is no conversation to speak in.
      return
    }
    if (this.store.reply.proactiveCountSince(target.convKey, now - 3_600_000) >= PROACTIVE_MAX_PER_HOUR) {
      this.ports.log.info(`lark-inbox: 本小时主动通知已达 ${PROACTIVE_MAX_PER_HOUR} 条，跳过`)
      return
    }
    const jobId = `fp_${sessionId.replace(/[^A-Za-z0-9_-]/gu, '_')}_${turn}`.slice(0, 50)
    const opened = this.store.reply.openProactive({
      jobId,
      convKey: target.convKey,
      sessionId: target.sessionId,
      now,
      windowMs: 3_600_000,
      max: PROACTIVE_MAX_PER_HOUR,
    })
    if (opened === undefined) return
    this.ports.log.info(`lark-inbox: 考虑主动通知 job=${jobId}（会话 ${sessionId} 跑了 ${Math.round((now - startedAt) / 1000)} 秒）`)
    this.requestSweep()
  }

  /**
   * Decide the outcome of a finished turn and send it.
   * @param job - the job the turn belongs to.
   * @param data - the `turn/end` payload.
   */
  private settleTurn(job: ReplyJob, data: Record<string, unknown>): void {
    const reason = typeof data.reason === 'object' && data.reason !== null ? data.reason as Record<string, unknown> : {}
    const kind = typeof reason.kind === 'string' ? reason.kind : ''
    const draft = (this.drafts.get(job.jobId) ?? '').trim()
    const stopped = job.stopRequested || this.store.reply.stopRequested(job.jobId)
    const timedOut = job.lastError === TIMEOUT_MARKER

    if (job.kind === 'proactive' && draft.trim().toUpperCase() === SILENT_REPLY_TOKEN) {
      this.closeSilently(job, this.ports.now())
      return
    }
    if (kind === 'completed' || kind === 'max-tokens') {
      // A step that hit its token ceiling still produced usable text more often
      // than not, so partial text wins over an error sentence.
      if (draft !== '') this.closeTurn(job, 'answer', draft, kind)
      else this.closeTurn(job, 'empty', fallbackReplyText('empty'), kind)
      return
    }
    if (kind === 'aborted') {
      // Text already streamed beats every stop-shaped outcome except an explicit
      // request to stop: the person asked a question, the answer exists, and
      // replacing it with "timed out" throws away the only thing they wanted.
      if (draft !== '' && !stopped) this.closeTurn(job, 'answer', draft, kind)
      else if (stopped) this.closeTurn(job, 'stopped', fallbackReplyText('stopped'), kind)
      else if (timedOut) this.closeTurn(job, 'timeout', fallbackReplyText('timeout'), kind)
      else this.closeTurn(job, 'interrupted', fallbackReplyText('interrupted'), kind)
      return
    }
    // `error` and `blocked` both mean the turn did not deliver what was asked;
    // the provider's own code travels with the sentence when it has one.
    const failure = typeof reason.error === 'object' && reason.error !== null ? reason.error as Record<string, unknown> : {}
    const detail = typeof failure.code === 'string'
      ? failure.code
      : typeof failure.message === 'string' ? failure.message : ''
    if (draft !== '') this.closeTurn(job, 'answer', draft, kind)
    else this.closeTurn(job, 'error', fallbackReplyText('error', detail), kind)
  }
}

/**
 * Turn an unknown thrown value into one line.
 * @param error - whatever was caught.
 * @returns a message safe to log and to show.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}