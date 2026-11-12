/**
 * Dossier and now projection (T11).
 *
 * Contract: docs/superagent/07-桌子.md (案卷六段, 单一在场) and plan/spec/T-11-desk.md.
 * The fixtures are inline rows on purpose: the projection has to be decidable
 * without a database, a clock or a network, because the fingerprint of a judge
 * window is only meaningful if two desks can recompute it from the same input.
 *
 * Tests 6 and 7 are the mechanical half of "在办永不截断". The negative control for
 * them is a config edit, not a code path: give `sections/open.ts` a `truncateRank`
 * instead of `neverTruncate: true` and every budget pass drops the open rows first,
 * which turns both cases red.
 */

import { describe, expect, it } from 'vitest'

import type { Audience } from '../src/host/services/superagent/memory/visibility.ts'
import { DERIVED_HINT_FALLBACK } from '../src/host/services/superagent/memory/disclose.ts'
import type { InboundEvent } from '../src/host/services/superagent/protocol/events.ts'
import type {
  CommitmentRow,
  MemoryRow,
  WorkClassRow,
} from '../src/host/services/superagent/protocol/objects.ts'
import { compileNow, PUB_OPEN_MAX, type LedgerView } from '../src/host/services/superagent/desk/now.ts'
import {
  ALARM_OPEN_OVER_8,
  ALARM_OVER_BUDGET,
  compileDossier,
  estimateTokens,
  splitBySender,
  type DossierContext,
  type DossierSection,
} from '../src/host/services/superagent/desk/dossier.ts'
import { buildDossierSections, DOSSIER_SECTIONS } from '../src/host/services/superagent/desk/sections/index.ts'

const NOW = Date.parse('2026-11-05T12:05:00+08:00')
const TZ = 'Asia/Shanghai'
const CTX: DossierContext = { tz: TZ, nowMs: NOW, generation: 3, deskLabel: 'p2p:oc_owner' }

const OWNER_P2P: Audience = { principals: ['party:owner'], cls: 'owner_p2p' }
const GROUP_WITH_OWNER: Audience = { principals: ['party:owner', 'party:alice'], cls: 'group_with_owner' }
const GROUP_WITHOUT_OWNER: Audience = { principals: ['party:alice', 'party:bob'], cls: 'group_without_owner' }

let seq = 0
function commit(over: Partial<CommitmentRow> & { commitment_id: string }): CommitmentRow {
  seq += 1
  return {
    commitment_id: over.commitment_id,
    n: seq,
    parent_id: null,
    kind: 'deliver',
    debtor: 'party:owner',
    creditor: 'party:owner',
    on_behalf_of: null,
    ball: 'me',
    desk_id: 'desk:1',
    thread_key: 'p2p:oc_owner:m1',
    origin_kind: 'event',
    origin_ref: `e${seq}`,
    work_class: 'run-tests',
    what: '只看 responder.spec 列用例',
    intent: 'know',
    check_kind: 'answer',
    done_when: 'answered',
    boundary: null,
    target: null,
    state: 'open',
    slot: null,
    due_at: null,
    eta_at: null,
    next_look_at: NOW + 60_000,
    eta_model_min: 3,
    eta_factor: 2.1,
    budget_wall_ms: null,
    budget_turns: null,
    used_wall_ms: 180_000,
    used_turns: 2,
    used_tokens: 0,
    extended: 0,
    evidence_json: null,
    actual_min: null,
    attempts: 1,
    executor_switched: 0,
    closed_at: null,
    created_at: NOW - 10 * 60_000,
    updated_at: NOW - 60_000,
    ...over,
  }
}

function memory(over: Partial<MemoryRow> & { memory_id: string }): MemoryRow {
  return {
    memory_id: over.memory_id,
    kind: 'constraint',
    topic: 'repo',
    about: null,
    body: '默认正文',
    authority: 'owner-said',
    source_event: 'e1',
    source_quote: null,
    commitment_id: null,
    supersedes: null,
    state: 'active',
    use_set: JSON.stringify(['party:owner']),
    say_set: JSON.stringify(['party:owner']),
    last_used_at: null,
    created_at: NOW - 3600_000,
    updated_at: NOW - 3600_000,
    ...over,
  }
}

function workClass(over: Partial<WorkClassRow> & { class_id: string }): WorkClassRow {
  return {
    class_id: over.class_id,
    samples: 6,
    eta_factor: 2.1,
    ask_mode: 'declare',
    pushback_mode: 'on',
    preferred_executor: 'x:fast',
    misjudge_rate: null,
    p90_turns: null,
    created_at: NOW - 86_400_000,
    updated_at: NOW - 3600_000,
    ...over,
  }
}

function row(over: Partial<InboundEvent> & { event_id: string }): InboundEvent {
  return {
    event_id: over.event_id,
    chat: { id: 'oc_owner', type: 'p2p' },
    sender: { open_id: 'ou_owner' },
    thread: 'p2p:oc_owner:m17',
    text: '你给他发消息，让他好好干活',
    message_id: `m-${over.event_id}`,
    received_at: NOW - 5_000,
    ...over,
  }
}

function baseView(over: Partial<LedgerView> = {}): LedgerView {
  return {
    open: [
      commit({ commitment_id: 'C-12', ball: 'executor:x:fast', what: '只看 responder.spec 列用例' }),
      commit({ commitment_id: 'C-9', what: '盯 pc-tower 会话 s-88', ball: 'me' }),
    ],
    waiting: [
      commit({ commitment_id: 'C-7', what: '是否允许改 dsh-cove 主仓', ball: 'party:owner', question: '是否允许改 dsh-cove 主仓', default: '不改' }),
    ],
    recentConclusions: [
      { deliberation_id: 'D-2', conclusion: '受理：改超时并跑测试', public: true },
      { deliberation_id: 'D-1', conclusion: '私聊细节，不外传', public: false },
    ],
    memories: [
      memory({ memory_id: 'M-3', body: 'dsh-cove 是公开仓库，别并发写', source_quote: 'dsh-cove 是公开仓库，别并发写' }),
      memory({ memory_id: 'M-5', authority: 'config', body: '生产变更必须逐目标授权' }),
    ],
    workClasses: [workClass({ class_id: 'run-tests' })],
    recentClosed: [commit({ commitment_id: 'C-4', what: '修 lark-inbox 超时', state: 'fulfilled', closed_at: NOW - 3600_000 })],
    attention: { interruptsToday: 1, quota: 3, quiet: '22:00-08:00', ownerLastSpokeAt: NOW - 120_000 },
    ...over,
  }
}

const BATCH: readonly InboundEvent[] = [
  row({ event_id: 'e19', text: '你给他发消息，让他好好干活' }),
]

function firstLineOf(text: string, label: string): string {
  return text.split('\n').find((line) => line.includes(label)) ?? ''
}

describe('now projection', () => {
  it('is idempotent and order-independent: same view and audience hash the same', () => {
    const view = baseView()
    const first = compileNow(view, OWNER_P2P)
    const second = compileNow(baseView(), OWNER_P2P)

    expect(second.pubHash).toBe(first.pubHash)
    expect(second.audHash).toBe(first.audHash)

    const shuffled: LedgerView = {
      ...view,
      open: [...view.open].reverse(),
      waiting: [...view.waiting].reverse(),
      recentConclusions: [...view.recentConclusions].reverse(),
      memories: [...view.memories].reverse(),
      workClasses: [...view.workClasses].reverse(),
      recentClosed: [...view.recentClosed].reverse(),
    }
    const reordered = compileNow(shuffled, OWNER_P2P)
    expect(reordered.pubHash).toBe(first.pubHash)
    expect(reordered.audHash).toBe(first.audHash)
    expect(first.degraded).toBe(false)
  })

  it('keeps the public core identical across audiences while the audience layer differs', () => {
    const view = baseView()
    const p2p = compileNow(view, OWNER_P2P)
    const group = compileNow(view, GROUP_WITH_OWNER)

    expect(group.pubHash).toBe(p2p.pubHash)
    expect(group.audHash).not.toBe(p2p.audHash)
    expect(p2p.audienceClass).toBe('owner_p2p')
    expect(group.audienceClass).toBe('group_with_owner')
  })

  it('never puts a private memory body or quote into a group-without-owner audience layer', () => {
    const privateRow = memory({
      memory_id: 'M-9',
      kind: 'person',
      body: '老板的私人手机 138 0013 8000，别在群里说',
      source_quote: '老板的私人手机 138 0013 8000',
      use_set: JSON.stringify(['party:alice']),
      say_set: JSON.stringify([]),
    })
    const view = baseView({ memories: [...baseView().memories, privateRow] })
    const projection = compileNow(view, GROUP_WITHOUT_OWNER)
    const rendered = JSON.stringify(projection.aud)

    expect(rendered).not.toContain('138 0013 8000')
    expect(rendered).not.toContain(privateRow.source_quote as string)
    expect(projection.aud.use.map((entry) => entry.memory_id)).toContain('M-9')
    const hinted = projection.aud.use.find((entry) => entry.memory_id === 'M-9')
    expect(hinted?.derived).toBe(true)
    expect(hinted?.text).toBe(DERIVED_HINT_FALLBACK)
    // The public core is shared with every other audience, so it must stay clean too.
    expect(JSON.stringify(projection.pub)).not.toContain('138 0013 8000')
  })

  it('degrades to the public core when a layer cannot be compiled', () => {
    const broken = baseView()
    broken.memories = [
      ...baseView().memories,
      { memory_id: 'M-bad', body: 42 } as unknown as MemoryRow,
    ]
    const projection = compileNow(broken, GROUP_WITH_OWNER)

    expect(projection.degraded).toBe(true)
    expect(projection.audHash).toBe(projection.pubHash)
    expect(projection.aud.use).toEqual([])
  })
})

describe('dossier', () => {
  it('shows the executor candidates the host computed, inside 判例(同类)', () => {
    const view = baseView()
    const ctx = { ...CTX, executorCandidates: ['oneshot-read(一次性/只读/成本1)', 'durable-full(长期/全工具/成本2)'] }
    const { text } = compileDossier(view, compileNow(view, OWNER_P2P), BATCH, ctx, 6000)

    expect(text).toContain('可派执行体: oneshot-read')
    expect(text).toContain('durable-full')
    // It rides in the precedent section, so the six-section layout is unchanged.
    expect(text.indexOf('可派执行体')).toBeGreaterThan(text.indexOf('判例(同类)'))
    expect(text.indexOf('可派执行体')).toBeLessThan(text.indexOf('注意力'))
  })

  it('renders the six sections in the fixed order', () => {
    const view = baseView()
    const { text } = compileDossier(view, compileNow(view, OWNER_P2P), BATCH, CTX, 6000)

    const order = ['在办(球权)', '等老板', '老板说过', '判例(同类)', '注意力', '本批']
    const positions = order.map((label) => text.indexOf(label))
    expect(positions.every((position) => position >= 0)).toBe(true)
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBeGreaterThan(positions[index - 1])
    }
  })

  it('a waiting row with no default says the default is to do it (owner M-2), never "not do"', () => {
    const view = baseView({
      waiting: [
        ...baseView().waiting,
        commit({ commitment_id: 'C-8', what: '要不要顺手清理旧分支', ball: 'party:owner', question: '要不要顺手清理旧分支' }),
      ],
    })
    const { text } = compileDossier(view, compileNow(view, OWNER_P2P), BATCH, CTX, 6000)
    const line = firstLineOf(text, 'C-8')

    expect(line).toContain('默认:做')
    expect(line).not.toContain('默认:不做')
    // A default the desk wrote is still shown as written.
    expect(firstLineOf(text, 'C-7')).toContain('默认:不改')
  })

  it('a colleague\'s waiting row with no default never promises "default: do"', () => {
    const view = baseView({
      waiting: [
        ...baseView().waiting,
        commit({ commitment_id: 'C-20', what: '同事要求重启服务', creditor: 'party:alice', on_behalf_of: 'party:owner', ball: 'party:owner', question: '同事要求重启服务' }),
        commit({ commitment_id: 'C-21', what: '拆出的子提案', creditor: 'party:alice', ball: 'party:owner' }),
      ],
    })
    const { text } = compileDossier(view, compileNow(view, OWNER_P2P), BATCH, CTX, 6000)

    for (const id of ['C-20', 'C-21']) {
      const line = firstLineOf(text, id)
      expect(line).not.toContain('默认:做')
      expect(line).toContain('等老板批准')
    }
  })

  it('yields precedent, then what the owner said, then waiting — and keeps every open row', () => {
    const view = baseView()
    const dossier = compileDossier(view, compileNow(view, OWNER_P2P), BATCH, CTX, 60)

    expect(dossier.truncated).toEqual(['precedent', 'said', 'waiting'])
    expect(dossier.text).toContain('C-12')
    expect(dossier.text).toContain('C-9')
    expect(dossier.text).not.toContain('判例(同类)')
    expect(dossier.text).not.toContain('老板说过')
    expect(dossier.text).not.toContain('等老板')
    expect(dossier.alarms).toContain(ALARM_OVER_BUDGET)
    // Budget arithmetic is characters over two, so the same snapshot always fits
    // the same way on every desk.
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(2)
    expect(estimateTokens('abcde')).toBe(3)
  })

  it('alarms on nine open rows without dropping any of them', () => {
    const open = Array.from({ length: 9 }, (_, index) => commit({ commitment_id: `C-${index + 1}` }))
    const view = baseView({ open })
    const dossier = compileDossier(view, compileNow(view, OWNER_P2P), BATCH, CTX, 60)

    expect(dossier.alarms).toContain(ALARM_OPEN_OVER_8)
    for (let index = 1; index <= 9; index += 1) expect(dossier.text).toContain(`C-${index}`)
    // The public core still carries at most eight; the dossier is where all nine show.
    expect(compileNow(view, OWNER_P2P).pub.open.length).toBe(PUB_OPEN_MAX)
  })

  it('writes sender and thread into every batch line', () => {
    const view = baseView()
    const batch = [row({ event_id: 'e19', sender: { open_id: 'ou_alice' }, thread: 'group:oc_g:m17', text: '顺手把 Z 也改了' })]
    const { text } = compileDossier(view, compileNow(view, GROUP_WITH_OWNER), batch, CTX, 6000)
    const line = firstLineOf(text, '[#e19')

    expect(line).toContain('ou_alice')
    expect(line).toContain('group:oc_g:m17')
    expect(line).toContain('顺手把 Z 也改了')
  })

  it('splits a mixed batch by sender and keeps arrival order', () => {
    const a1 = row({ event_id: 'A1', sender: { open_id: 'ou_a' } })
    const b1 = row({ event_id: 'B1', sender: { open_id: 'ou_b' } })
    const a2 = row({ event_id: 'A2', sender: { open_id: 'ou_a' } })

    const groups = splitBySender([a1, b1, a2])
    expect(groups.map((group) => group.map((event) => event.event_id))).toEqual([['A1', 'A2'], ['B1']])
  })

  it('places a newly registered section at its order without touching the core', () => {
    const stub: DossierSection = {
      name: 'stub',
      label: '桩段',
      order: 4.5,
      maxTokens: 200,
      render: () => '桩段          测试用一段',
    }
    const view = baseView()
    const { text } = compileDossier(
      view,
      compileNow(view, OWNER_P2P),
      BATCH,
      CTX,
      6000,
      buildDossierSections([stub]),
    )

    expect(text.indexOf('判例(同类)')).toBeLessThan(text.indexOf('桩段'))
    expect(text.indexOf('桩段')).toBeLessThan(text.indexOf('注意力'))
    // The shipped set is untouched by the extra registration.
    expect(DOSSIER_SECTIONS.length).toBe(6)
  })

  it('keeps at most eight remembered statements, each with its words and date', () => {
    const memories = Array.from({ length: 10 }, (_, index) => memory({
      memory_id: `M-${String(index + 1).padStart(2, '0')}`,
      body: `第 ${index + 1} 条约束`,
      source_quote: `第 ${index + 1} 条约束`,
      created_at: Date.parse('2026-11-04T21:50:00+08:00'),
      updated_at: Date.parse('2026-11-04T21:50:00+08:00'),
    }))
    const view = baseView({ memories })
    const { text } = compileDossier(view, compileNow(view, OWNER_P2P), BATCH, CTX, 6000)

    const saidLines = text.split('\n').filter((line) => line.includes('条约束'))
    expect(saidLines.length).toBe(8)
    for (const line of saidLines) {
      expect(line).toContain('11-04 21:50')
      expect(line).toContain('「')
    }
    expect(text).not.toContain('第 9 条约束')
    expect(text).not.toContain('第 10 条约束')
  })
})