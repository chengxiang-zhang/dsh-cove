/** Stable semantic stamp regression for shell columns and frame ownership. */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { DEFAULT_STAMPS, applyCompat } from '../src/client/compat.ts'

describe('shell semantic compatibility stamps', () => {
  it('keeps all three column contracts', () => {
    expect(DEFAULT_STAMPS.columns.map(column => column[1])).toEqual([
      'data-pane="sidebar"',
      'data-pane="conversation"',
      'data-pane="details"',
    ])
    expect(DEFAULT_STAMPS.frameAttribute).toBe('data-dsh-frame')
  })

  it('stamps real column elements and their shared frame idempotently', () => {
    document.body.innerHTML = '<main><aside class="hash_sidebarCol"></aside><section class="hash_centerCol"></section><aside class="hash_detailsCol"></aside></main>'
    expect(applyCompat()).toBe(true)
    expect(document.querySelector('[class*="sidebarCol"]')?.getAttribute('data-pane')).toBe('sidebar')
    expect(document.querySelector('[class*="centerCol"]')?.getAttribute('data-pane')).toBe('conversation')
    expect(document.querySelector('[class*="detailsCol"]')?.getAttribute('data-pane')).toBe('details')
    expect(document.querySelector('main')?.hasAttribute('data-dsh-frame')).toBe(true)
    expect(applyCompat()).toBe(false)
  })
})
