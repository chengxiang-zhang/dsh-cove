// @vitest-environment jsdom
/**
 * The DOM layer is a single synchronous pass now: badge text comes from the
 * sessions list projection, not from an async history fetch, so a row whose
 * child has no model is simply left alone.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  scanSubagentRows,
  type SubagentBadgeDeps,
} from '../src/client/conversation/subagent-model-dom.ts'

const LABEL = 'inspect the GUI'
const CHILD = 'child-1'
const MODEL = 'kaon/deepseek-v4-flash-0731'

function deps(overrides: Partial<SubagentBadgeDeps> = {}): SubagentBadgeDeps {
  return {
    labels: new Map([[LABEL, CHILD]]),
    models: new Map([[CHILD, `${MODEL} · high`]]),
    ariaLabel: value => `Subagent model and reasoning effort ${value}`,
    ...overrides,
  }
}

function catalogRow(markup: string): Element {
  const row = document.createElement('div')
  row.setAttribute('role', 'treeitem')
  row.innerHTML = markup
  document.body.append(row)
  return row
}

afterEach(() => { document.body.innerHTML = '' })

describe('subagent model DOM presentation', () => {
  it('injects the semantic model and effort badge into a catalog row', () => {
    const row = catalogRow(`<span>${LABEL}</span><span class="metrics">12k tok · done</span>`)

    scanSubagentRows(document.body, deps())
    const badge = row.querySelector('[data-dsh-plugin="subagent-model"]')
    expect(badge?.textContent).toBe(`${MODEL} · high`)
    expect(badge?.getAttribute('data-dsh-part')).toBe('badge')
    expect(badge?.getAttribute('aria-label')).toContain(`${MODEL} · high`)
  })

  it('is idempotent and refreshes the existing badge', () => {
    const row = catalogRow(`<span>${LABEL}</span><span>· done</span>`)
    scanSubagentRows(document.body, deps({ models: new Map([[CHILD, MODEL]]) }))
    scanSubagentRows(document.body, deps())
    expect(row.querySelectorAll('[data-dsh-plugin="subagent-model"]')).toHaveLength(1)
    expect(row.querySelector('[data-dsh-plugin="subagent-model"]')?.textContent).toBe(`${MODEL} · high`)
  })

  it('leaves tool-call rows without a known model untouched', () => {
    const row = document.createElement('div')
    row.textContent = `Tool call subagent · ${LABEL}`
    document.body.append(row)
    scanSubagentRows(document.body, deps({ models: new Map() }))
    expect(row.querySelector('[data-dsh-plugin="subagent-model"]')).toBeNull()
  })

  it('augments matching tool-call rows when the model is known', () => {
    const row = document.createElement('div')
    row.textContent = `Tool call subagent · ${LABEL}`
    document.body.append(row)
    scanSubagentRows(document.body, deps())
    expect(row.querySelector('[data-dsh-plugin="subagent-model"]')?.textContent).toBe(`${MODEL} · high`)
  })

  it('chooses the longest known label', () => {
    const row = catalogRow(`<span>${LABEL}</span><span>· done</span>`)
    scanSubagentRows(document.body, deps({
      labels: new Map([[LABEL, CHILD], ['inspect', 'short']]),
      models: new Map([[CHILD, MODEL], ['short', 'wrong']]),
    }))
    expect(row.querySelector('[data-dsh-plugin="subagent-model"]')?.textContent).toBe(MODEL)
  })
})