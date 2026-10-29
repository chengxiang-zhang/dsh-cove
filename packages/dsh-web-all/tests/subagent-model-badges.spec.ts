/**
 * The 0.2 fact resolution behind the subagent badge.
 *
 * Regression guards: the resolver must not read `sessions.list.current` or
 * `subagentsByParent` (both removed in DSH 0.2) and must never require a
 * history fetch — the catalog and the model both ride the list snapshot's
 * projections.
 */
import { describe, expect, it } from 'vitest'
import {
  formatModelText,
  resolveSubagentBadges,
  rootSessionId,
  type SubagentListRowLike,
} from '../src/core/subagent-model/badges.ts'

const ROOT = 'session-root'
const CHILD = 'subagent-child'
const MODEL = 'kaon/deepseek-v4-flash-0731'
const CHILD_LABEL = 'Audit host-half drift'
const CHILD_TITLE = 'Audit host-half drift (done)'

function rows(overrides: Record<string, SubagentListRowLike> = {}): Record<string, SubagentListRowLike> {
  return {
    [ROOT]: {
      id: ROOT,
      displayTitle: '项目记忆功能不加载',
      projectionValues: { subagentCatalog: [{ id: CHILD, mode: 'continuable', label: CHILD_LABEL }] },
    },
    [CHILD]: {
      id: CHILD,
      origin: 'subagent',
      parentId: ROOT,
      displayTitle: CHILD_TITLE,
      projectionValues: { modelSelection: { lastUsed: { provider: 'kaon', model: MODEL, reasoningEffort: 'high' }, next: null } },
    },
    ...overrides,
  }
}

describe('subagent badge facts', () => {
  it('walks a child up to its conversation root', () => {
    const list = rows()
    expect(rootSessionId(list, CHILD)).toBe(ROOT)
    expect(rootSessionId(list, ROOT)).toBe(ROOT)
    expect(rootSessionId(list, 'unknown')).toBe('unknown')
  })

  it('resolves the catalog child with its label and model text', () => {
    const resolution = resolveSubagentBadges({ byId: rows() }, ROOT)
    expect(resolution.rootId).toBe(ROOT)
    expect(resolution.badges).toEqual([
      { childId: CHILD, labels: [CHILD_LABEL, CHILD_TITLE], modelText: `${MODEL} · high` },
    ])
  })

  it('resolves the same badges from a subagent session (root walk)', () => {
    const resolution = resolveSubagentBadges({ byId: rows() }, CHILD)
    expect(resolution.rootId).toBe(ROOT)
    expect(resolution.badges.map(badge => badge.childId)).toEqual([CHILD])
  })

  it('falls back to the parent-keyed projection when the row has no catalog', () => {
    const list = rows({ [ROOT]: { id: ROOT, projectionValues: {} } })
    const resolution = resolveSubagentBadges({
      byId: list,
      projectionsBySession: { [ROOT]: { values: { subagentCatalog: [{ id: CHILD }] } } },
    }, ROOT)
    expect(resolution.badges.map(badge => badge.childId)).toEqual([CHILD])
  })

  it('prefers the committed selection over the pending intent', () => {
    const list = rows({
      [CHILD]: {
        id: CHILD,
        origin: 'subagent',
        parentId: ROOT,
        projectionValues: {
          modelSelection: { lastUsed: { model: 'ran-with' }, next: { model: 'pending' } },
        },
      },
    })
    expect(resolveSubagentBadges({ byId: list }, ROOT).badges[0]?.modelText).toBe('ran-with')
  })

  it('reports a child without a model and never invents one', () => {
    const list = rows({
      [CHILD]: { id: CHILD, origin: 'subagent', parentId: ROOT, projectionValues: { modelSelection: null } },
    })
    expect(resolveSubagentBadges({ byId: list }, ROOT).badges[0]?.modelText).toBeUndefined()
  })

  it('returns nothing without a selected session, and ignores malformed entries', () => {
    expect(resolveSubagentBadges({ byId: rows() }, undefined).badges).toEqual([])
    expect(resolveSubagentBadges({ byId: rows() }, '').badges).toEqual([])

    const malformed = rows({
      [ROOT]: { id: ROOT, projectionValues: { subagentCatalog: [null, 42, { label: 'no id' }, { id: CHILD }] } },
    })
    expect(resolveSubagentBadges({ byId: malformed }, ROOT).badges.map(badge => badge.childId)).toEqual([CHILD])
  })

  it('formats model and effort defensively', () => {
    expect(formatModelText({ model: MODEL })).toBe(MODEL)
    expect(formatModelText({ model: MODEL, reasoningEffort: 'high' })).toBe(`${MODEL} · high`)
    expect(formatModelText({ model: '  ' })).toBeUndefined()
    expect(formatModelText(null)).toBeUndefined()
    expect(formatModelText('model')).toBeUndefined()
  })
})