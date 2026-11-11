import { createHash } from 'node:crypto'
import { createManagedAdmission, type ManagedHostConfig } from './managed-runtime.ts'
import { managedWorkRoutes } from './surface/managed-routes.ts'
import type { DeliveryEvaluation } from './protocol/delivery.ts'
import { renderWorkReport } from './surface/templates.ts'
/**
 * Superagent service domain: the composition root (T27).
 *
 * One Cordis mount, organized by module inside. `register(ctx)` adapts the host
 * (Feishu channel, session controller, events, web server, access fence) onto
 * `createSuperagent`, which only assembles and wires: no module logic lives here.
 *
 * Start order is fixed (11): open the ledger -> build every module -> recovery
 * startup -> only then open admission and start the timers. Until startup is done
 * every inbound stays with the responder, exactly as before this domain existed.
 * The three-way switch is read per inbound (N13); claim's owner CAS decides who
 * answers, one owner per event.
 */

import { registerDshNativeRoles, type DshNativeHostConfig } from './executors/engines/dsh.ts'
import { existsSync } from 'node:fs'
import { hostname, homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { accessTrustOf } from '../access-trust/index.ts'
import { familyNamespace } from '../family-config.ts'
import { createFeishuTextSender } from '../feishu/index.ts'
import { LARK_INBOX_SETTINGS_NAMESPACE, effectiveConfig, resolveQueueDir, type LarkInboxConfig } from './channels/feishu/admin/config.ts'
import { createTestEgress } from './channels/feishu/testbed.ts'
import { deliverReaction } from './channels/feishu/react.ts'
import { deliverText } from './channels/feishu/send.ts'
import * as feishu from './channels/feishu/index.ts'
import { InboxStore } from './channels/feishu/inbox-store.ts'
import type { AdmitResult } from './channels/feishu/channel.ts'
import { parseSuperagentConfig, type SuperagentConfig, type SuperagentMode } from './config.ts'
import { createPresence, type Presence } from './desk/presence.ts'
import { createToolFace, hostToolOf, type AgentScopeLike, type ToolFacePort } from './desk/toolface.ts'
import { idemKeyOf } from './desk/tools.ts'
import { createExecutors } from './executors/attempts.ts'
import { createClosure } from './executors/closure.ts'
import { createEscalation, type EscalationReason } from './executors/escalate.ts'
import type { ToolDefinitionLike } from './executors/report-tool.ts'
import { createProfileRegistry } from './executors/profiles/index.ts'
import type { HostClock, HostLog, SessionControllerFace } from './host-ports.ts'
import { amendTool, releaseHost, releaseTool } from './judgment/amend-release.ts'
import { commitTool } from './judgment/commit.ts'
import { createDispatcher } from './judgment/dispatch.ts'
import { applyFastpath } from './judgment/fastpath-apply.ts'
import { gateFacts, senderClassOf, type JudgmentDeps, type TurnContext as JudgeTurn } from './judgment/gates.ts'
import { judgeTool } from './judgment/judge.ts'
import { proposeTool } from './judgment/propose.ts'
import { pushbackTool } from './judgment/pushback.ts'
import { createRoutePolicy } from './judgment/route.ts'
import type { SenderClass } from './judgment/route-rules.ts'
import type { JudgmentTurn, WorkClassPort } from './judgment/translate.ts'
import { createClaim, threadKeyOf } from './kernel/claim.ts'
import { createClock } from './kernel/clock.ts'
import { createLease } from './kernel/lease.ts'
import { createLedger, type Ledger } from './kernel/ledger.ts'
import { createOutlet, type Outlet } from './kernel/outlet.ts'
import type { OutletPolicy, SenderPort, SpeechProposal } from './kernel/ports.ts'
import { addDoc, listDocs, readDoc } from './memory/docs.ts'
import { remember as rememberRow, retireStale, visibility as visibilityOf, type MemoryLog } from './memory/log.ts'
import { applyPromotion, promoteCandidatesOf } from './memory/promote.ts'
import { disclosuresOf, recall } from './memory/recall.ts'
import type { Audience as MemoryAudience } from './memory/visibility.ts'
import { openLedgerDb, PHYSICAL } from './protocol/db.ts'
import type { InboundEvent } from './protocol/events.ts'
import { parseEndReason, type AttemptRow, type CommitmentRow, type DeskRow, type WorkClassRow } from './protocol/objects.ts'
import type { SayOutput, ToolResult } from './protocol/tools.ts'
import { createRecovery, type Recovery, type StartupReport } from './recovery/startup.ts'
import { createRuleRegistry } from './rules/registry.ts'
import { createCommands, type CommandTrust } from './surface/commands/index.ts'
import { makeCommandRoutes } from './surface/routes.ts'
import { createTickSignal } from './timing/agenda/index.ts'
import type { AttentionContext } from './timing/attention.ts'
import { createBrief, createBriefNow } from './timing/brief.ts'
import { createOutletPolicy } from './timing/outlet-policy.ts'
import { DEFAULT_TABLE } from './world/defaults.ts'
import { applyWorldConfig, parseWorldConfig } from './world/adapters/config.ts'
import { createWorldRegistry, type WorldRegistry } from './world/registry.ts'

export type { ManagedHostConfig } from './managed-runtime.ts'
export type { DshNativeHostConfig } from './executors/engines/dsh.ts'
export { parseSuperagentConfig, type SuperagentConfig } from './config.ts'

export const TICK_MS = 60_000
export const FLUSH_MS = 1_000
export const DAY_MS = 86_400_000
export const DISPOSE_WAIT_MS = 5_000
export const DESK_PRESET = 'superagent-desk'

export interface AssemblyDeps {
  managedAdmission?: (event: InboundEvent) => void
  /** Opens the ledger file; defaults to `openLedgerDb` (migrate + self-check). */
  openDb?: (path: string) => DatabaseSync
  /** The switch, desk, world and attention keys, read fresh on every use (N13). */
  config: () => SuperagentConfig
  controller: () => SessionControllerFace
  clock: HostClock
  log: HostLog
  /** The Feishu channel's send/react as the kernel's port. */
  sender: SenderPort
  /** This process's identity on the outlet lease. */
  holder: string
  /** Root for executor working directories. */
  seatRoot: string
  /** Default desk seat directory (D10) when the configuration names none. */
  seatDir: string
  /** The agent-scope adapter for the desk tool face (S1). */
  toolface: ToolFacePort
  /** Diagnostic sink for the composition root itself. */
  diagnostic?: (message: string) => void
  tz?: string
}

export interface Assembly {
  managedResult(event: InboundEvent, evaluate: () => DeliveryEvaluation): void
  /** The channel's admission hook. Synchronous; 'responder' until startup is done. */
  admit(event: InboundEvent): AdmitResult
  /** Opens the ledger at `path`, builds the modules, runs startup, then opens admission. */
  start(path: string): Promise<StartupReport | undefined>
  /** True once admission is open. */
  ready(): boolean
  onSessionEvent(sessionId: string, event: unknown): void
  /** Per-session model override (N5): desk config first, then the executor profile. */
  modelFor(sessionId: string): { provider: string; model: string; effort?: string } | undefined
  /** Command routes behind the injected access fence. */
  routes(trust: CommandTrust): WebRoute[]
  dispose(): Promise<void>
  /** For tests and diagnostics: the live ledger, when one is open. */
  ledger(): Ledger | undefined
  /** The executor `report` tool, registered on every `sa-x-*` session (02 executor tool). */
  reportTool(): ToolDefinitionLike | undefined
}

/** Apply a model override to a resolved request config without touching anything global (X3, F14). */
export function overrideModel(resolved: LlmCallConfig, model: { provider: string; model: string; effort?: string } | undefined): LlmCallConfig {
  if (!model) return resolved
  return { ...resolved, provider: model.provider, model: model.model, ...(model.effort ? { reasoningEffort: model.effort } : {}) } as LlmCallConfig
}

const OWNER_CLASSES: readonly SenderClass[] = ['owner', 'colleague', 'member', 'external']

interface Machine {
  db: DatabaseSync
  ledger: Ledger
  claim: ReturnType<typeof createClaim>
  policy: ReturnType<typeof createRoutePolicy>
  presence: Presence
  executors: ReturnType<typeof createExecutors>
  closure: ReturnType<typeof createClosure>
  escalation: ReturnType<typeof createEscalation>
  outlet: Outlet
  outletPolicy: OutletPolicy
  recovery: Recovery
  fastDeps: Parameters<typeof applyFastpath>[0]
  commands: ReturnType<typeof createCommands>
  briefNow: () => Promise<unknown>
  world: WorldRegistry
  memory: MemoryLog
  dispatcher: ReturnType<typeof createDispatcher>
  stopClock?: () => void
}

export function createSuperagent(deps: AssemblyDeps): Assembly {
  const managedReports = new Map<string, () => DeliveryEvaluation>()
  const managedEvidence = (key: string): DeliveryEvaluation | undefined => { try { return managedReports.get(key)?.() } catch (error) { return { verdict: 'fail', reason: String(error), receipt: null } } }

  const { log } = deps
  const diag = (m: string): void => { log.warn(m); deps.diagnostic?.(m) }
  let hostSpeakToOwner: ((proposal: SpeechProposal) => void) | undefined
  let machine: Machine | undefined
  let open = false
  let disposed = false
  let starting: Promise<StartupReport | undefined> | undefined
  const timers: unknown[] = []
  let lastBriefDay = ''

  const mode = (): SuperagentMode => deps.config().superagentMode
  const owner = (): string => deps.config().superagentWorld.owners[0]?.union_id ?? ''
  const ownerName = (): string => deps.config().superagentWorld.owners[0]?.name ?? '老板'
  const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...(deps.tz ? { timeZone: deps.tz } : {}) })
  const day = (ms: number): string => new Date(ms).toLocaleDateString('en-CA', deps.tz ? { timeZone: deps.tz } : {})
  const every = (ms: number, fn: () => void): void => {
    const h = deps.clock.setInterval(() => { try { fn() } catch (error) { log.warn(`superagent: timer: ${String(error)}`) } }, ms)
    ;(h as { unref?: () => void } | undefined)?.unref?.()
    timers.push(h)
  }

  function build(db: DatabaseSync): Machine {
    const ledger = createLedger(db, deps.clock)
    const read = ledger.read
    const claim = createClaim(ledger)
    const kernelClock = createClock(ledger)
    const lease = createLease(ledger)
    const outlet = createOutlet(ledger, lease, deps.holder, row => {
      if (row.payload !== 'text') return true
      // Recheck persisted rows too: a pre-upgrade or delayed free-form claim must
      // not bypass the current evidence boundary merely by already being queued.
      if (row.moment === 'deliver') { const evidence = managedEvidence(row.idem_key); return evidence?.verdict === 'pass' && row.body === renderWorkReport('deliver', 'fulfilled', evidence) }
      const proposal: SpeechProposal = { chat_id: row.chat_id, ...(row.commitment_id ? { commitment_id: row.commitment_id } : {}), moment: row.moment, payload: row.payload, audience: row.audience, text: row.body, idem_key: row.idem_key }
      const report = workReport(proposal)
      if (!report) return true
      const text = renderWorkReport(row.moment, report.state, undefined, report.commitmentId, report.facts)
      return row.body === text || row.body === `我是${ownerName()}的代理，${text}`
    })
    const profiles = createProfileRegistry()
    const world = createWorldRegistry({ read, clock: deps.clock, defaults: DEFAULT_TABLE, report: { warn: m => log.warn(m), degrade: e => diag(`world: ${e.reason} ${e.scope}`) } })

    // World from configuration: parties, entities, mandates (only people grant).
    const cfg = deps.config().superagentWorld
    ledger.open(tx => {
      for (const p of cfg.owners) world.registerParty(tx, { party_id: p.union_id, union_id: p.union_id, display: p.name, class: 'owner', source: 'config' })
      for (const p of cfg.colleagues) world.registerParty(tx, { party_id: p.union_id, union_id: p.union_id, display: p.name, class: 'colleague', source: 'config' })
      const parsed = parseWorldConfig({ entities: cfg.entities, mandates: cfg.mandates })
      for (const problem of parsed.problems) log.warn(`superagent world config: ${problem}`)
      applyWorldConfig(world, tx, parsed, 1)
    }, { module: 'world' })

    const memory: MemoryLog = {
      remember: (entry, trigger) => ledger.open(tx => rememberRow(tx, entry, trigger), { module: 'memory' }),
      recall: (q, audience, purpose, limit) => recall(read, q, audience, purpose, limit),
      visibility: id => visibilityOf(read, id),
      promoteCandidates: d => promoteCandidatesOf(read, d, owner()),
      applyPromotion: (id, approved) => ledger.open(tx => applyPromotion(tx, id, approved), { module: 'memory' }),
      disclosures: (text, audience) => disclosuresOf(read, text, audience),
      retireStale: now => ledger.open(tx => retireStale(tx, now), { module: 'memory' }),
    }
    const rules = createRuleRegistry({ open: (fn, o) => ledger.open(fn, { module: o?.module ?? 'rules' }), read })
    try { ledger.open(tx => rules.checkConflicts(tx), { module: 'rules' }) } catch (error) { log.warn(`superagent rules: ${String(error)}`) }

    const deskOfChat = (chatId: string): DeskRow | undefined => read.get<DeskRow>(`SELECT * FROM ${PHYSICAL.desk} WHERE chat_id = ?`, chatId)
    const audienceOfChat = (chatId: string): MemoryAudience => {
      const d = deskOfChat(chatId)
      return { principals: [owner()].filter(Boolean), cls: d?.audience_class ?? (d?.chat_type === 'p2p' ? 'owner_p2p' : 'group_without_owner') }
    }
    const ownerChat = (chatId: string): boolean => audienceOfChat(chatId).cls === 'owner_p2p'
    const commitmentOf = (id?: string): CommitmentRow | undefined => id ? read.get<CommitmentRow>(`SELECT * FROM ${PHYSICAL.commitment} WHERE commitment_id = ?`, id) : undefined
    const attentionCtx = (p: SpeechProposal, now: number): AttentionContext => {
      const c = commitmentOf(p.commitment_id)
      const a = deps.config().superagentAttention
      const interrupts = read.get<{ n: number }>(`SELECT count(*) AS n FROM ${PHYSICAL.outbox} WHERE tier = 'interrupt' AND created_at >= ?`, now - (now % DAY_MS))?.n ?? 0
      return { moment: p.moment, ballToOwnerWithClock: !!c && c.ball === owner() && c.state === 'at_risk', irreversible: false,
        // 09 reply tier: an answer to what just arrived, or a delivery the requester is waiting on.
        isReplyToInbound: p.event_id !== undefined || (p.moment === 'deliver' && c?.origin_kind === 'event'), interruptsToday: interrupts, quotaPerDay: a.interruptQuota, localHHMM: hhmm(now), quiet: a.quiet }
    }
    // Provenance is host object identity, never a model-selectable idempotency prefix.
    const hostProposals = new WeakSet<object>()
    const workReport = (p: SpeechProposal) => {
      const delivery = managedEvidence(p.idem_key)
      if (delivery?.verdict === 'pass') return { state: 'fulfilled', delivery }
      const explicit = commitmentOf(p.commitment_id)
      const byChat = read.get<CommitmentRow>(`SELECT c.* FROM ${PHYSICAL.commitment} c JOIN ${PHYSICAL.desk} d ON d.desk_id = c.desk_id WHERE d.chat_id = ? ORDER BY c.created_at DESC LIMIT 1`, p.chat_id)
      const work = explicit ?? byChat
      if (!work) return undefined
      const question = read.get<{ ordinal: number; question: string }>(`SELECT ordinal,question FROM ${PHYSICAL.assumption} WHERE commitment_id=? AND mode='asked' AND status='open' ORDER BY ordinal LIMIT 1`, work.commitment_id)
      const progress = read.get<{ attempt_id: string; state: string; tool_calls: number }>(`SELECT attempt_id,state,tool_calls FROM ${PHYSICAL.attempt} WHERE commitment_id=? ORDER BY started_at DESC LIMIT 1`, work.commitment_id)
      return { state: work.state, commitmentId: work.commitment_id, facts: {
        ...(question ? { question: { ref: work.commitment_id + ':assumption:' + question.ordinal, text: question.question } } : {}),
        ...(progress ? { progress: { ref: progress.attempt_id, state: progress.state, toolCalls: progress.tool_calls } } : {}),
      } }
    }
    const outletPolicy = createOutletPolicy({
      attentionCtx,
      workReport,
      momentFacts: p => {
        const c = commitmentOf(p.commitment_id)
        // The formal row first; a shadow turn's disposition lives on shadow=1 (N18).
        const intake = p.event_id ? read.get<{ disposition: string | null }>(
          `SELECT disposition FROM ${PHYSICAL.intake} WHERE event_id = ? AND disposition IS NOT NULL ORDER BY shadow LIMIT 1`, p.event_id) : undefined
        const now = ledger.nowMs()
        return {
          committedInThisTurn: !!c && c.created_at >= now - 120_000,
          commitmentTerminal: (!!c && c.closed_at !== null) || managedEvidence(p.idem_key)?.verdict === 'pass',
          deliveryEvidence: managedEvidence(p.idem_key),
          dispositionAnswersInbound: intake?.disposition !== null && intake?.disposition !== undefined
            && ['answer', 'check', 'decline', 'acknowledge'].includes(intake.disposition),
          hasAskedAssumptionOrRoute: intake?.disposition === 'route' || intake?.disposition === 'ask'
            || (!!c && read.get(`SELECT 1 FROM ${PHYSICAL.assumption} WHERE commitment_id = ? AND mode = 'asked' AND status = 'open'`, c.commitment_id) !== undefined),
          brokenOrAtRiskOrDispatchFailed: !!c && (c.state === 'broken' || c.state === 'at_risk'
            || read.get(`SELECT 1 FROM ${PHYSICAL.attempt} WHERE commitment_id = ? AND end_reason = 'dispatch_failed'`, c.commitment_id) !== undefined),
          isAgendaTurnWithSignal: !!c && read.get(`SELECT 1 FROM ${PHYSICAL.deliberation} WHERE commitment_id = ? AND trigger_kind = 'agenda'`, c.commitment_id) !== undefined,
          byPushbackTool: p.source === 'pushback',
          byHost: hostProposals.has(p),
        }
      },
      disclosures: (text, chatId) => memory.disclosures(text, audienceOfChat(chatId)),
      mayPromise: chatId => ownerChat(chatId) || world.mandate(owner(), 'local/', 'commit_promise').strength === 'allow',
      identityNeeded: chatId => !ownerChat(chatId),
      ownerLabel: () => ownerName(),
    })
    const hostSpeak = (p: SpeechProposal): void => {
      hostProposals.add(p)
      const r = outlet.submit(p, outletPolicy, mode())
      if (!r.ok) log.warn(`superagent outlet: ${p.moment} refused ${r.code}: ${r.message}`)
    }

    const executors = createExecutors({ ledger, controller: deps.controller, world, profiles, clock: deps.clock, log, seatRoot: deps.seatRoot,
      speak: hostSpeak, askOwner: (id, q, d) => diag(`ask owner on ${id}: ${q} (default: ${d})`) })
    const closure = createClosure({ ledger, facts: executors, artifacts: { pathExists: p => existsSync(p), branchCommits: () => 0 } })
    hostSpeakToOwner = hostSpeak
    const escalation = createEscalation({ ledger, profiles, clock: deps.clock, speak: hostSpeak })
    const dispatcher = createDispatcher(executors, log)

    // Desk-facing say: shadow validates only (N18); otherwise one outbox row.
    const sayCounters = new Map<string, number>()
    const outletSay = (ctx: JudgmentTurn | JudgeTurn, p: Omit<SpeechProposal, 'idem_key'>): ToolResult<SayOutput> => {
      const n = (sayCounters.get(ctx.deliberationId) ?? 0) + 1
      sayCounters.set(ctx.deliberationId, n)
      // Fast-path turns have no model: their lines are the host's own (decline notice,
      // greeting reaction), so they carry the host prefix and the host moment rules.
      const scope = ctx.deliberationId.startsWith('fp:') ? `fp:${ctx.deliberationId.slice(3)}` : `j:${ctx.deliberationId}`
      const proposal: SpeechProposal = { ...p, idem_key: idemKeyOf(scope, n) }
      if (ctx.deliberationId.startsWith('fp:')) hostProposals.add(proposal)
      if (ctx.shadow) {
        const v = outletPolicy.check(proposal, ledger.nowMs())
        ;(ctx as JudgmentTurn).shadowOps?.push({ tool: 'say', input: p, verdict: v.ok ? 'ok' : v.code })
        return v.ok ? { ok: true, outbox_id: 'shadow', tier: v.tier, words: v.words } : { ok: false, code: v.code, message: v.message }
      }
      const r = outlet.submit(proposal, outletPolicy, mode())
      return r.ok ? { ok: true, outbox_id: r.outboxId, tier: r.tier, words: r.words } : { ok: false, code: r.code, message: r.message }
    }
    const classes: WorkClassPort = {
      get: id => read.get<WorkClassRow>(`SELECT * FROM ${PHYSICAL.work_class} WHERE class_id = ?`, id),
      ensure: id => ledger.open(tx => {
        tx.run(`INSERT OR IGNORE INTO ${PHYSICAL.work_class} (class_id, samples, eta_factor, ask_mode, pushback_mode, created_at, updated_at)
          VALUES (?, 0, 1, 'declare', 'on', ?, ?)`, id, tx.now, tx.now)
        return tx.get<WorkClassRow>(`SELECT * FROM ${PHYSICAL.work_class} WHERE class_id = ?`, id) as WorkClassRow
      }, { module: 'rules' }),
    }
    const judgmentDeps: JudgmentDeps = { ledger, claim, world, memory, rules, outletSay, profiles }
    const facts = (ctx: JudgmentTurn, event: InboundEvent) => gateFacts(judgmentDeps, ctx as JudgeTurn, event)
    const say = (ctx: JudgmentTurn, p: Omit<SpeechProposal, 'idem_key'>): unknown => outletSay(ctx, p)
    const ar = { ledger, executors, owner: owner(), say }
    const commit = commitTool({ ledger, profiles, facts, classes, owner: owner(), dispatcher, say })
    const judge = judgeTool(judgmentDeps)
    const pushback = pushbackTool(judgmentDeps)
    const amend = amendTool(ar)
    const release = releaseTool(ar)
    const propose = proposeTool({ ledger, owner: owner(), say })
    const flip = <I, R>(fn: (ctx: never, input: I) => R) => (input: unknown, ctx: unknown) => fn(ctx as never, input as I) as never

    let recovery: Recovery | undefined
    const presence = createPresence({
      ledger, controller: deps.controller, clock: deps.clock, log, memory, docs: { read: id => readDoc(read, id) },
      outlet, outletPolicy, mode,
      handlers: { judge: flip(judge), commit: flip(commit), amend: flip(amend), release: flip(release), pushback: flip(pushback), propose: flip(propose) },
      toolface: createToolFace(deps.toolface),
      config: () => {
        const d = deps.config().superagentDesk
        return { seatDir: d.seatDir ?? deps.seatDir, preset: d.preset ?? DESK_PRESET, ...(d.model ? { model: d.model } : {}),
          idleEvictMs: 1_800_000, rotateEvents: 4000, collectWindowMs: 3000, dossierTokens: 6000, owner: owner(),
          executorCandidates: profiles.all().map(p => `${p.id}(${p.lifetime === 'durable' ? '长期' : '一次性'}/${p.tools === 'full' ? '全工具' : '只读'}/成本${String(p.cost_tier)})`),
          ...(deps.tz ? { tz: deps.tz } : {}) }
      },
      degrade: e => { recovery?.degrade(e.reason, e.scope) },
      recover: e => { recovery?.recover(e.reason, e.scope) },
    })
    recovery = createRecovery({ ledger, lease, holder: deps.holder, clock: deps.clock, log, controller: deps.controller,
      executors, closure, escalation, presence, outlet })

    const brief = createBrief({ read, promoteCandidates: () => [] })
    const briefNow = createBriefNow({ brief, now: () => ledger.nowMs(), day,
      submit: b => hostSpeak({ chat_id: '', moment: 'brief', audience: 'owner', payload: 'text', text: b.body, idem_key: `sa:brief:${day(ledger.nowMs())}` }) })
    const commands = createCommands({
      read, now: () => ledger.nowMs(),
      release: id => releaseHost({ ledger, cancelSession: sid => { void Promise.resolve(deps.controller().cancel({ sessionId: sid })).catch(() => undefined) } }, id),
      briefNow,
      docs: {
        add: path => ledger.open(tx => addDoc(tx, path, basename(path), 'handoff', 'human'), { module: 'memory' }),
        list: q => listDocs(read, q),
      },
    })
    const policy = createRoutePolicy({
      senderClass: e => {
        const cls = senderClassOf(read, e.sender.union_id ?? e.sender.open_id)
        return (OWNER_CLASSES as readonly string[]).includes(cls) ? cls as SenderClass : 'unknown'
      },
    })
    return { db, ledger, claim, policy, presence, executors, closure, escalation, outlet, outletPolicy, recovery, commands, briefNow, world, memory, dispatcher,
      fastDeps: { ...ar, dispatcher, profiles, defaultProfile: 'durable-full', rotateDesk: id => { presence.rotate(id, 'manual') } },
      stopClock: undefined, kernelClock } as Machine & { kernelClock: ReturnType<typeof createClock> }
  }

  function startTimers(m: Machine & { kernelClock?: ReturnType<typeof createClock> }): void {
    const tickSignal = createTickSignal(m.ledger.read)
    m.stopClock = m.kernelClock?.start(deps.clock, tickSignal, r => { void m.presence.runTurn(r).catch(e => log.warn(`superagent turn: ${String(e)}`)) })
    every(TICK_MS, () => {
      const now = deps.clock.now()
      void m.recovery.reconcile(now).catch(e => log.warn(`superagent reconcile: ${String(e)}`))
      m.closure.pendingSweep(now)
      void m.executors.supervise(now).catch(e => log.warn(`superagent supervise: ${String(e)}`))
      m.presence.evictIdle(now)
      const a = deps.config().superagentAttention
      if (hhmm(now) >= a.briefAt && lastBriefDay !== day(now)) {
        lastBriefDay = day(now)
        void m.briefNow().catch(e => log.warn(`superagent brief: ${String(e)}`))
      }
    })
    every(FLUSH_MS, () => {
      const now = deps.clock.now()
      void m.presence.tick(now).catch(e => log.warn(`superagent desk tick: ${String(e)}`))
      void m.outlet.flush(now, deps.sender).catch(e => log.warn(`superagent flush: ${String(e)}`))
    })
    every(DAY_MS, () => { m.memory.retireStale(deps.clock.now()) })
  }

  function route(m: Machine, event: InboundEvent, kind: 'judge' | 'fastpath' | 'passthrough', decisionOf: () => Parameters<typeof applyFastpath>[2]): void {
    if (kind === 'judge') { m.presence.enqueue(event); return }
    if (kind === 'fastpath') {
      void applyFastpath(m.fastDeps, event, decisionOf()).catch(e => log.warn(`superagent fastpath ${event.event_id}: ${String(e)}`))
      return
    }
    const key = threadKeyOf(event)
    const sub = m.ledger.read.get<{ attempt_id: string }>(`SELECT attempt_id FROM ${PHYSICAL.subscription} WHERE thread_key = ?`, key)
    if (sub) void m.executors.sendInput(sub.attempt_id, `pt:${event.event_id}`, event.text).catch(e => log.warn(`superagent passthrough: ${String(e)}`))
  }

  return {
    managedResult(event, evaluate) {
      const m = machine
      if (!m) return
      const key = 'sa:managed:' + createHash('sha256').update(event.event_id).digest('hex').slice(0, 32)
      managedReports.set(key, evaluate)
      const result = managedEvidence(key)!
      hostSpeakToOwner?.({ chat_id: event.chat.id, reply_to: event.message_id, moment: result.verdict === 'pass' ? 'deliver' : 'cannot', audience: 'owner', payload: 'text', idem_key: key, text: result.verdict === 'pass' ? renderWorkReport('deliver', 'fulfilled', result) : '此事项尚未完成交付。需要处理的实际阻断：' + JSON.stringify(result.reason.slice(0, 100)) })
    },
    admit(event) {
      const m = machine
      if (!open || !m || disposed) return 'responder'
      const current = mode()
      let decision: ReturnType<typeof m.policy.decide> | undefined
      const policy = { decide: (e: InboundEvent, s: Parameters<typeof m.policy.decide>[1]) => (decision = m.policy.decide(e, s)) }
      const r = m.claim.claim(event, policy, current)
      if (r.status === 'already_claimed') return 'already_claimed'
      if (r.status === 'shadowed') { m.presence.enqueue(event); return 'shadow' }
      if (r.owner === 'responder') return 'responder'
      if (deps.managedAdmission && event.chat.type === 'p2p' && deps.config().superagentWorld.owners.some(owner => owner.union_id === event.sender.union_id)) {
        try {
          deps.managedAdmission(event)
          m.ledger.open(tx => tx.disposeIntake(event.event_id, 0, { disposition: 'answer', reason: 'Persisted managed admission owns this request' }), { module: 'judgment' })
        } catch (error) {
          log.warn('managed admission refused: ' + String(error))
          m.ledger.open(tx => tx.disposeIntake(event.event_id, 0, { disposition: 'answer', reason: 'Managed admission failed before native execution' }), { module: 'judgment' })
          hostSpeakToOwner?.({ chat_id: event.chat.id, reply_to: event.message_id, event_id: event.event_id, moment: 'cannot', audience: 'owner', payload: 'text', idem_key: 'sa:managed-fail:' + createHash('sha256').update(event.event_id).digest('hex').slice(0, 24), text: '受控入口未能保存这项请求，尚未开始执行。原因：' + JSON.stringify(String(error).slice(0, 80)) })
        }
        return 'superagent'
      }
      route(m, event, r.route, () => decision as never)
      return 'superagent'
    },
    async start(path) {
      if (starting) return starting
      starting = (async () => {
        let db: DatabaseSync
        try {
          db = (deps.openDb ?? openLedgerDb)(path)
        } catch (error) {
          diag(`superagent: ledger unavailable at ${path}: ${error instanceof Error ? error.message : String(error)}; the responder keeps every event`)
          return undefined
        }
        let m: Machine
        try {
          m = build(db)
        } catch (error) {
          diag(`superagent: assembly failed: ${error instanceof Error ? error.message : String(error)}`)
          db.close()
          return undefined
        }
        machine = m
        const report = await m.recovery.startup()
        if (disposed) return report
        open = true   // admission opens only after startup (11)
        startTimers(m)
        return report
      })()
      return starting
    },
    ready: () => open,
    onSessionEvent(sessionId, event) {
      const m = machine
      if (!m) return
      m.executors.onSessionEvent(sessionId, event)
      m.presence.onSessionEvent(sessionId, event)
      const e = (typeof event === 'object' && event !== null && 'event' in event && !('type' in event) ? (event as { event: unknown }).event : event) as { type?: unknown; data?: { reason?: { kind?: unknown } } }
      if (e?.type !== 'turn/end') return
      const a = m.ledger.read.get<AttemptRow>(`SELECT * FROM ${PHYSICAL.attempt} WHERE session_id = ? AND state <> 'ended'`, sessionId)
      if (!a) return
      try {
        const reason = parseEndReason(e.data?.reason?.kind)
        const report = m.executors.lastReport(a.attempt_id)
        const result = m.closure.close(a.attempt_id, { reason }, report)
        if (result.state === 'fulfilled' || result.state === 'unverified' || result.state === 'broken') {
          // The host's report signal (10): one desk turn on the commitment says the delivery.
          const requestId = `report:${a.attempt_id}`
          const did = m.ledger.open(tx => tx.requestTurn({ trigger_kind: 'report', commitment_id: a.commitment_id, request_id: requestId }), { module: 'desk' })
          if (did) void m.presence.runTurn({ deliberation_id: did, request_id: requestId, commitment_id: a.commitment_id, trigger_kind: 'report' })
            .catch(err => log.warn(`superagent report turn: ${String(err)}`))
        } else if (result.state === 'escalate') {
          const why: EscalationReason = reason === 'completed' ? (report?.state === 'blocked' ? 'blocked_technical' : 'failed')
            : reason === 'max-tokens' || reason === 'interrupted' || reason === 'error' ? reason : 'failed'
          m.escalation.escalate(a.commitment_id, why)
        }
      } catch (error) {
        log.warn(`superagent closure ${a.attempt_id}: ${String(error)}`)
      }
    },
    modelFor(sessionId) {
      const m = machine
      return m ? (m.presence.modelFor(sessionId) ?? m.executors.modelFor(sessionId)) : undefined
    },
    routes(trust) {
      // Routes exist from mount; before the ledger opens every command answers "no data".
      const commands = { run: async (...args: Parameters<Machine['commands']['run']>) => {
        const m = machine
        if (!m) return { json: { error: 'superagent ledger not open' }, text: 'superagent 账本未打开', exitCode: 3 as const }
        return m.commands.run(...args)
      } }
      return makeCommandRoutes(commands, trust)
    },
    async dispose() {
      disposed = true
      open = false
      for (const h of timers.splice(0)) deps.clock.clearInterval(h)
      const m = machine
      if (!m) return
      m.stopClock?.()
      m.recovery.dispose()
      const wait = (p: Promise<unknown>): Promise<unknown> => Promise.race([p, new Promise(r => { const h = setTimeout(r, DISPOSE_WAIT_MS); h.unref?.() })])
      await wait(Promise.all([m.presence.drain(), m.dispatcher.settle()]))
      try { m.db.close() } catch { /* already closed */ }
      machine = undefined
    },
    ledger: () => machine?.ledger,
    reportTool: () => machine?.executors.report,
  }
}

// ---------------------------------------------------------------------------
// Host adapter
// ---------------------------------------------------------------------------

function dshHome(env: NodeJS.ProcessEnv): string {
  const raw = env.DSH_HOME?.trim()
  if (!raw) return join(homedir(), '.dsh')
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return raw
}

/**
 * The desk tool face over the real agent scope (S1): an `agent/created` listener
 * keeps the agent ctx of every `sa-desk-*` session; restrict, scoped registration
 * and guard go to that ctx's tool registry. Until a scope is seen the port throws,
 * which the desk turns into "desk unavailable" (fail closed, nothing is said).
 */
function agentScopePort(ctx: Context, own: (dispose: () => void) => void): ToolFacePort {
  const scopes = new Map<string, { tools: Record<string, (...a: unknown[]) => unknown>; agent: unknown }>()
  own(ctx.on('agent/created' as never, ((payload: { agent?: { session?: { id?: unknown }; ctx?: { tools?: unknown } } }) => {
    const id = payload.agent?.session?.id
    const tools = payload.agent?.ctx?.tools
    if (typeof id === 'string' && id.startsWith('sa-desk-') && tools) scopes.set(id, { tools: tools as Record<string, (...a: unknown[]) => unknown>, agent: payload.agent })
    return undefined
  }) as never) as () => void)
  return {
    async scope(sessionId): Promise<AgentScopeLike> {
      const s = scopes.get(sessionId)
      if (!s) throw new Error(`superagent desk: no agent scope for ${sessionId}`)
      const call = (name: string, ...args: unknown[]): unknown => (s.tools[name] as (...a: unknown[]) => unknown).call(s.tools, ...args)
      return {
        restrict: o => call('restrict', o) as () => void,
        register: tool => call('register', hostToolOf(tool, sessionId)) as () => void,
        guard: fn => call('guard', (exec: { name: string; agent?: unknown }) => fn({ name: exec.name, agent: exec.agent ?? sessionId })) as () => void,
        visible: () => {
          try { return ((call('schemas', s.agent) as { name: string }[] | undefined) ?? []).map(x => x.name) } catch { return [] }
        },
      }
    },
  }
}

/**
 * Mount the superagent domain.
 * @param ctx - the host context the owning row runs in.
 * @returns the disposer that releases every module the domain mounted.
 */
export function register(ctx: Context, nativeExecutors?: DshNativeHostConfig, managedWork?: ManagedHostConfig): () => Promise<void> {
  const log = ctx.logger('superagent')
  const hostLog: HostLog = { info: m => log.info('%s', m), warn: m => log.warn('%s', m), error: m => log.error('%s', m) }
  const disposers: (() => void)[] = []
  const own = (d: () => void): void => { disposers.push(d) }
  const disposeNativeRoles = registerDshNativeRoles(ctx, nativeExecutors)
  const controller = (): SessionControllerFace => {
    const svc = (ctx.get as unknown as (id: string, strict?: boolean) => unknown)('sessionController', false)
    if (!svc) throw new Error('sessionController is not available')
    return svc as SessionControllerFace
  }
  let replySender: Parameters<typeof deliverText>[0] | undefined
  const sender: SenderPort = {
    send: async (chatId, text, idemKey, replyTo) => deliverText(replySender, chatId, text, replyTo, idemKey),
    react: async (messageId, emoji) => deliverReaction(replySender as never, messageId, emoji),
  }
  const home = dshHome(process.env)
  const inboxNamespace = () => familyNamespace<LarkInboxConfig>(LARK_INBOX_SETTINGS_NAMESPACE)
  const managedEvents = new Map<string, InboundEvent>()
  let managed: ReturnType<typeof createManagedAdmission> | undefined
  const assembly = createSuperagent({
    ...(managedWork ? { managedAdmission: (event: InboundEvent) => {
      if (!managed) throw new Error('MANAGED_ADMISSION_NOT_READY')
      const match = /^\/work\s+(\S+)\s+([\s\S]+)$/.exec(event.text)
      managedEvents.set(event.event_id, event)
      managed.enqueue({ requestId: 'feishu:' + event.event_id, ...(match ? { project: match[1], text: match[2]! } : { text: event.text }), origin: { kind: 'feishu', chatId: event.chat.id, messageId: event.message_id, eventId: event.event_id } })
    } } : {}),
    config: () => parseSuperagentConfig(familyNamespace(LARK_INBOX_SETTINGS_NAMESPACE)),
    controller,
    clock: { now: () => Date.now(), setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: h => clearInterval(h as NodeJS.Timeout) },
    log: hostLog,
    sender,
    holder: `${hostname()}:${process.pid}`,
    seatRoot: join(home, 'superagent'),
    seatDir: join(home, 'superagent', 'desk'),
    toolface: agentScopePort(ctx, own),
  })
  if (managedWork) {
    managed = createManagedAdmission(managedWork, (request, result) => {
      const event = request.origin.eventId && managedEvents.get(request.origin.eventId)
      if (event) assembly.managedResult(event, result.evaluate)
    })
    for (const route of managedWorkRoutes(managed, request => accessTrustOf(ctx).isTrusted(request))) own(ctx.webServer.register(route))
  }
  const disposeChannel = feishu.register(ctx, {}, {
    admit: event => assembly.admit(event),
    // The ledger lives in the queue's own file, opened only after the store has
    // created inbox_events (protocol start-order contract).
    createStore: options => {
      const store = InboxStore.open(options)
      void assembly.start(join(options.rootDir, 'inbox.sqlite'))
      return store
    },
    createSender: credentials => {
      // The live test harness (testbed.ts): the same sender port, but every line is
      // captured to a file instead of reaching Feishu. Read here, at the one moment
      // the sender is built, so the flag cannot change under a running runtime.
      if (effectiveConfig(inboxNamespace()).testHarness) {
        const egress = createTestEgress(resolveQueueDir(effectiveConfig(inboxNamespace()), home))
        log.warn('superagent: testHarness 开启，出站写入 %s', egress.file)
        replySender = egress.sender as never
        return egress.sender as never
      }
      const s = createFeishuTextSender({ credentials, log: m => log.warn('%s', m) })
      replySender = s as never
      return s
    },
  })
  own(ctx.on('session/event', (session: unknown, event: unknown) => {
    const id = typeof session === 'object' && session !== null ? (session as { id?: unknown }).id : undefined
    if (typeof id === 'string' && id !== '') assembly.onSessionEvent(id, event)
  }))
  own(ctx.on<'agent/request'>('agent/request', async (payload, next) => {
    const resolved = await next()
    const id = (payload as { agent?: { session?: { id?: unknown } } }).agent?.session?.id
    return typeof id === 'string' ? overrideModel(resolved, assembly.modelFor(id)) : resolved
  }))
  // The executor report tool, scoped to each executor session (02 executor tool).
  own(ctx.on('agent/created' as never, ((payload: { agent?: { session?: { id?: unknown }; ctx?: { tools?: { register?: (d: unknown) => () => void } } } }) => {
    const id = payload.agent?.session?.id
    const tool = assembly.reportTool()
    const tools = payload.agent?.ctx?.tools
    if (typeof id === 'string' && id.startsWith('sa-x-') && tool && typeof tools?.register === 'function') {
      tools.register(hostToolOf(tool, id))
    }
    return undefined
  }) as never) as () => void)
  for (const r of assembly.routes({ isTrusted: request => accessTrustOf(ctx).isTrusted(request) })) own(ctx.webServer.register(r))
  return async () => {
    await managed?.dispose()
    await disposeNativeRoles()
    for (const d of disposers.splice(0).reverse()) { try { d() } catch { /* keep unwinding */ } }
    await assembly.dispose()
    await disposeChannel()
  }
}
export { createVerificationService } from './verification/index.ts'

export { createManagedRuntime, createManagedLocalDelivery } from './managed-runtime.ts'
