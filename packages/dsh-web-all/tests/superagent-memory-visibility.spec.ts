/**
 * Memory visibility contracts (T07).
 *
 * 05 splits "may be used to judge" from "may be said out loud": the append-only
 * table stores only the `use_set` / `say_set` atoms and every answer is a pure
 * function of the audience. Expectations are inlined here on purpose — the test
 * is the second, independent copy of the contract.
 */

import { describe, expect, it } from 'vitest'
import {
  AUTHORITIES,
  MEMORY_KINDS,
  MEMORY_STATES,
  type Authority,
  type MemoryKind,
  type MemoryRow,
} from '../src/host/services/superagent/protocol/objects.ts'
import {
  DEFAULT_VISIBILITY,
  PROMOTION_KIND_WEIGHT,
  PROMOTION_LIMIT,
  authorityRank,
  canSay,
  canUse,
  mayOverride,
  promotionCandidates,
  resolveDefaultVisibility,
  serializePrincipals,
  type Audience,
  type PromotionRow,
} from '../src/host/services/superagent/memory/visibility.ts'
import {
  DERIVED_HINT_FALLBACK,
  DISCLOSURE_MIN_LCS,
  derivedHint,
  disclosures,
  longestCommonSubstring,
  quoteInTrigger,
  type HintCarrier,
} from '../src/host/services/superagent/memory/disclose.ts'

const OWNER = 'P-OWNER'
const COLLEAGUE = 'P-COLLEAGUE'
const NOW = 1_760_000_000_000
const DAY = 86_400_000

const p2p: Audience = { principals: [OWNER], cls: 'owner_p2p' }
const groupWithOwner: Audience = { principals: [OWNER, COLLEAGUE], cls: 'group_with_owner' }
const groupWithoutOwner: Audience = { principals: [COLLEAGUE], cls: 'group_without_owner' }
const emptyAudience: Audience = { principals: [], cls: 'group_without_owner' }

function memory(overrides: Partial<MemoryRow> = {}): MemoryRow {
  return {
    memory_id: 'M-1',
    kind: 'constraint',
    topic: 'repo-concurrency',
    about: null,
    body: '前提是公开仓库，不允许并发写同一个分支',
    authority: 'owner-said',
    source_event: 'evt-1',
    source_quote: '前提是公开仓库，不允许并发写同一个分支',
    commitment_id: null,
    supersedes: null,
    state: 'active',
    use_set: JSON.stringify([OWNER]),
    say_set: JSON.stringify([OWNER]),
    last_used_at: null,
    created_at: NOW,
    updated_at: null,
    ...overrides,
  }
}

function withHint(row: MemoryRow, bodyJson: string | null): HintCarrier {
  return { ...row, body_json: bodyJson }
}

describe('superagent memory visibility', () => {
  it('1. 私聊老板原话：三种受众求值，五种记忆默认可见域', () => {
    const privateFact = memory()
    // 受众只有老板：可用可说
    expect(canUse(privateFact, p2p)).toBe(true)
    expect(canSay(privateFact, p2p)).toBe(true)
    // 老板在群里：可用于判断，不得说出
    expect(canUse(privateFact, groupWithOwner)).toBe(true)
    expect(canSay(privateFact, groupWithOwner)).toBe(false)
    // 老板不在：连判断都不能用
    expect(canUse(privateFact, groupWithoutOwner)).toBe(false)
    expect(canSay(privateFact, groupWithoutOwner)).toBe(false)

    const p2pContext = { owner: OWNER, where: 'p2p' as const }
    // 能说的人永远不超出能判断的人
    for (const kind of MEMORY_KINDS) {
      const resolved = resolveDefaultVisibility(kind, p2pContext)
      expect(resolved.say.every((principal) => resolved.use.includes(principal))).toBe(true)
    }
    expect(resolveDefaultVisibility('constraint', p2pContext)).toEqual({ use: [OWNER], say: [OWNER] })
    expect(resolveDefaultVisibility('preference', p2pContext)).toEqual({ use: [OWNER], say: [OWNER] })
    expect(resolveDefaultVisibility('standing', p2pContext)).toEqual({ use: [OWNER], say: [OWNER] })
    expect(resolveDefaultVisibility('person', p2pContext)).toEqual({ use: [OWNER], say: [] })
    // 判例绑承诺受众；受众缺失时解析为空，宁可不可用也不默认公开
    expect(resolveDefaultVisibility('precedent', p2pContext)).toEqual({ use: [], say: [] })
    expect(canSay(memory({ kind: 'precedent', authority: 'config', use_set: '[]', say_set: '[]' }), p2p)).toBe(false)

    // 群里老板原话：判断面扩到群成员，说面仍只有老板
    const groupContext = { owner: OWNER, where: 'group' as const, groupMembers: [OWNER, COLLEAGUE] }
    for (const kind of ['constraint', 'preference', 'standing'] as const) {
      const resolved = resolveDefaultVisibility(kind, groupContext)
      expect(resolved.say).toEqual([OWNER])
      expect(resolved.use).toContain(COLLEAGUE)
    }
    expect(resolveDefaultVisibility('person', groupContext)).toEqual({ use: [OWNER], say: [] })
    // 默认表恰好覆盖五种记忆，一种不多一种不少
    expect([...MEMORY_KINDS].sort()).toEqual(Object.keys(DEFAULT_VISIBILITY).sort())
  })

  it('2. superseded 等非 active 的条目不可用不可说', () => {
    for (const state of MEMORY_STATES) {
      const row = memory({ state })
      if (state === 'active') {
        expect(canUse(row, p2p)).toBe(true)
        expect(canSay(row, p2p)).toBe(true)
        continue
      }
      expect(canUse(row, p2p)).toBe(false)
      expect(canSay(row, p2p)).toBe(false)
      expect(canSay(row, groupWithOwner)).toBe(false)
      expect(canSay(row, groupWithoutOwner)).toBe(false)
    }
  })

  it('3. 空受众不可说；升公共候选只挑 say 只剩老板的条目，至多 5 条', () => {
    expect(canSay(memory(), emptyAudience)).toBe(false)
    expect(canUse(memory(), emptyAudience)).toBe(false)

    const candidate = (memoryId: string, kind: MemoryKind, ageDays: number): PromotionRow =>
      memory({ memory_id: memoryId, kind, last_used_at: NOW - ageDays * DAY })
    const rows: PromotionRow[] = [
      candidate('M-C1', 'constraint', 1),
      candidate('M-C2', 'constraint', 9),
      candidate('M-P1', 'preference', 2),
      candidate('M-P2', 'preference', 3),
      candidate('M-P3', 'preference', 4),
      candidate('M-P4', 'preference', 20),
      candidate('M-S1', 'standing', 1),
      // 已公共：没有可扩的面
      memory({
        memory_id: 'M-PUB',
        kind: 'preference',
        use_set: serializePrincipals([OWNER, COLLEAGUE]),
        say_set: serializePrincipals([OWNER, COLLEAGUE]),
        last_used_at: NOW,
      }),
      // say 为空：不是"只有老板能听"的私聊事实
      memory({ memory_id: 'M-OBS', kind: 'person', say_set: '[]', last_used_at: NOW }),
      // 非 active
      memory({ memory_id: 'M-GONE', kind: 'constraint', state: 'superseded', last_used_at: NOW }),
      // 可见域原子读不出：按不可说处理，也不进候选
      memory({ memory_id: 'M-NOATOM', kind: 'constraint', say_set: 'not-json', last_used_at: NOW }),
    ]

    const ids = promotionCandidates(rows, OWNER, NOW)
    expect(ids).toEqual(['M-C1', 'M-C2', 'M-P1', 'M-P2', 'M-P3'])
    expect(ids).toHaveLength(PROMOTION_LIMIT)
    expect(ids).not.toContain('M-PUB')
    expect(ids).not.toContain('M-OBS')
    expect(ids).not.toContain('M-GONE')
    expect(ids).not.toContain('M-NOATOM')
    // 没有候选就返回空，不为了有事做而提问
    expect(promotionCandidates([], OWNER, NOW)).toEqual([])
    // 打分只决定顺序：约束优先于偏好
    expect(PROMOTION_KIND_WEIGHT.constraint).toBeGreaterThan(PROMOTION_KIND_WEIGHT.preference)
  })

  it('4. 字面兜底：12 字连续片段命中、11 字不命中；原话逐字校验', () => {
    const fact = memory()
    // 12 / 11 是 05 写死的契约数字，这里独立抄写，不跟实现常量推导
    const run12 = fact.body.slice(2, 14)
    const run11 = fact.body.slice(2, 13)
    expect(run12).toHaveLength(12)
    expect(run11).toHaveLength(11)

    expect(disclosures(`结论：${run12}。`, [fact])).toEqual([fact.memory_id])
    expect(disclosures(`结论：${run11}。`, [fact])).toEqual([])
    expect(longestCommonSubstring(`结论：${run12}。`, fact.body)).toBe(12)
    expect(disclosures('', [fact])).toEqual([])
    // 阈值本身也是契约数字，放在行为断言之后，免得遮蔽行为读数
    expect(DISCLOSURE_MIN_LCS).toBe(12)

    // 原话校验：owner-said 的 quote 必须是本批某条消息的逐字子串
    const batch = ['先说一句。dsh-cove 是公开仓库，别并发写。下面继续']
    expect(quoteInTrigger('dsh-cove 是公开仓库，别并发写', batch)).toBe(true)
    expect(quoteInTrigger('dsh-cove 是公开仓库，别并发乱写', batch)).toBe(false)
    expect(quoteInTrigger('', batch)).toBe(false)
  })

  it('5. 数字串与邮箱 token 命中', () => {
    const contact = memory({
      memory_id: 'M-CONTACT',
      body: '老板的手机 13800138000，邮箱 leo@example.com',
      source_quote: '我手机 13800138000',
    })
    expect(disclosures('回他 13800138000', [contact])).toEqual(['M-CONTACT'])
    // 邮箱大小写不敏感
    expect(disclosures('发到 Leo@Example.com 就行', [contact])).toEqual(['M-CONTACT'])
    expect(disclosures('别外传这条', [contact])).toEqual([])
    // 已知残留：源不分组、草稿分组时 token 包含比较不命中（见回执）
    expect(disclosures('拨 138-0013-8000 找他', [contact])).toEqual([])
  })

  it('6. 金丝雀标记：正文含 CANARY-7Q2 即命中', () => {
    const canary = memory({
      memory_id: 'M-CANARY',
      body: 'CANARY-7Q2 老板的私人项目代号',
      source_quote: 'CANARY-7Q2 别外传',
    })
    // 连续片段只有 11 字，命中只能来自金丝雀 token（05 的读数按 LIKE '%CANARY-%' 回读）
    expect(longestCommonSubstring('群里汇报：CANARY-7Q2 已经上线', canary.body)).toBe(11)
    expect(disclosures('群里汇报：CANARY-7Q2 已经上线', [canary])).toEqual(['M-CANARY'])
    expect(disclosures('群里汇报：canary-7q2 已经上线', [canary])).toEqual(['M-CANARY'])
  })

  it('7. 派生提示不含 body 与 source_quote 的任何 12 字片段', () => {
    const samples: Array<{ row: HintCarrier; expected: string }> = [
      // 抽取器没存 hint：回退到固定形状
      { row: memory({ memory_id: 'M-H0' }), expected: DERIVED_HINT_FALLBACK },
      // 存了 hint：正常返回
      {
        row: withHint(memory({ memory_id: 'M-H1', body: '老板不喜欢长回复，一句话能说清就一句' }), '{"hint":"回复要短"}'),
        expected: '回复要短',
      },
      // hint 自己就是原文：丢弃，回退
      {
        row: withHint(memory({ memory_id: 'M-H2', body: '群里别喊老板真名，一律用老板' }), '{"hint":"群里别喊老板真名，一律用老板"}'),
        expected: DERIVED_HINT_FALLBACK,
      },
      // hint 空白
      {
        row: withHint(memory({ memory_id: 'M-H3', body: '每天早上十点前不要发简报' }), '{"hint":"   "}'),
        expected: DERIVED_HINT_FALLBACK,
      },
      // body_json 不是 JSON
      {
        row: withHint(memory({ memory_id: 'M-H4', body: '发版前必须跑 docs:check' }), '{not json'),
        expected: DERIVED_HINT_FALLBACK,
      },
    ]
    for (const { row, expected } of samples) {
      const hint = derivedHint(row)
      expect(hint).toBe(expected)
      expect(hint.length).toBeGreaterThan(0)
      for (const source of [row.body, row.source_quote]) {
        if (typeof source !== 'string') continue
        expect(longestCommonSubstring(hint, source)).toBeLessThan(12)
      }
    }
  })

  it('8. 权威序：低权威不能覆盖高权威，同权威可以', () => {
    expect(mayOverride('observed', 'owner-said')).toBe(false)
    expect(mayOverride('owner-said', 'config')).toBe(true)
    expect(mayOverride('owner-said', 'owner-said')).toBe(true)
    expect(mayOverride('config', 'owner-said')).toBe(false)
    expect(mayOverride('inferred', 'observed')).toBe(false)
    expect(authorityRank('owner-said')).toBe(0)
    // 权威序与 AUTHORITIES 数组序一致（owner-said 最高）
    expect([...AUTHORITIES]).toEqual(['owner-said', 'config', 'party-said', 'observed', 'inferred'])
    AUTHORITIES.forEach((authority, index) => expect(authorityRank(authority)).toBe(index))
    // 覆盖判据整体上与排序一致
    for (const next of AUTHORITIES) {
      for (const prev of AUTHORITIES) {
        expect(mayOverride(next, prev)).toBe(authorityRank(next) <= authorityRank(prev))
      }
    }
    // 未知值不猜：按最低权威处理
    expect(authorityRank('made-up' as Authority)).toBe(AUTHORITIES.length)
  })
})