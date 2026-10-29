import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = async (path: string): Promise<string> => await readFile(resolve(process.cwd(), path), 'utf8')

/** Rule bodies keyed by their whitespace-normalized selector list, comments stripped. */
function rules(css: string): Map<string, string> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const map = new Map<string, string>()
  for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    map.set(selector.trim().replace(/\s+/g, ' '), body.trim().replace(/\s+/g, ' '))
  }
  return map
}

/**
 * The sidebar header row is official DOM carrying the official brand lockup and
 * the collapse control. This suite owns two invariants over the stylesheet that
 * reshapes it: no brand artwork is ever visible (expanded header or collapsed
 * rail), and the collapse control is reachable at the foot in both states - a
 * hidden or off-screen control would strand a collapsed sidebar.
 */
describe('sidebar header chrome', () => {
  const cssPath = 'src/client/sidebar/sidebar-header.module.css'
  const pane = "[data-pane='sidebar']"

  it('hides the official brand element itself, not only its contents', async () => {
    const css = rules(await source(cssPath))
    // Hiding the inner identity would leave the official brand button - a
    // keyboard-focusable, clickable "new session" target - in the header row.
    expect(css.get(`${pane} [class*='_logoRow'] > [class*='_brand']`)).toBe('display: none;')
  })

  it('collapses the header row it emptied, in both states', async () => {
    const css = rules(await source(cssPath))
    const body = css.get(`${pane} [class*='_logoRow']`)
    expect(body).toContain('height: 0;')
    expect(body).toContain('overflow: visible;')
  })

  it('anchors the collapse control on the sidebar panel and places it at the foot', async () => {
    const css = rules(await source(cssPath))
    expect(css.get(pane)).toBe('position: relative;')
    // The settings row is a full-width button; the control overlaps its right
    // end, so it must win hit testing there (both are positioned, z-index auto).
    expect(css.get(`${pane}:not(:has([class*='_collapsed'])) [class*='_toggle']`))
      .toBe('position: absolute; z-index: 2; right: 12px; bottom: 16px;')
    // The rail keeps the same control above the settings gear, centred.
    const rail = css.get(`${pane}:has([class*='_collapsed']) [class*='_toggle']`)
    expect(rail).toContain('position: absolute; z-index: 2;')
    expect(rail).toContain('bottom: 60px;')
    expect(rail).toContain('margin-inline: auto;')
  })

  it('never renders the official brand mark in the rail, and keeps a visible glyph on the control', async () => {
    const css = rules(await source(cssPath))
    expect(css.get(`${pane} [class*='_railMark']`)).toBe('display: none;')
    expect(css.get(`${pane}:has([class*='_collapsed']) [class*='_panelIcon']`)).toBe('display: inline;')
  })

  it('is wired into the sidebar position module so the stylesheet loads with the plugin', async () => {
    expect(await source('src/client/sidebar/index.ts')).toContain("import './sidebar-header.module.css'")
  })
})