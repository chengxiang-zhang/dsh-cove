/**
 * Geometry of the branch chip's hero seat: the official hero chip row is found
 * structurally and the chip is placed after its rightmost painted chip.
 *
 * The offsets live here instead of inside the component because the composer
 * stack is `position: static`: absolute offsets have to be taken against the
 * anchor's own containing block (`offsetParent`), and a stack-relative formula
 * lands the chip hundreds of pixels away from the row. Keeping the math pure
 * keeps that mistake testable.
 * @module dsh-git-graph/client/chips/heroSeat
 */

/** Horizontal gap between the official hero-row chips (WorkspaceChip / AgentPresetSeat). */
export const HERO_CHIP_GAP = 2

/** Height of an official hero-row chip, matching the `.chipHero` min-height. */
export const HERO_CHIP_HEIGHT = 28

/** The anchor's containing block, in border-box coordinates. */
export interface HeroBlockBox {
  left: number
  top: number
  clientLeft: number
  clientTop: number
}

/** The official hero chip row, in border-box coordinates. */
export interface HeroRowBox {
  top: number
  height: number
}

/** Chip offsets, in the containing block's coordinate space. */
export interface HeroPlacement {
  left: number
  top: number
}

/**
 * The official hero chip row, when the dock row sits directly under it: the
 * slot outlet renders as `display: contents`, so the row is the outlet's
 * previous element sibling. Anything else (no previous sibling, the headline,
 * a notice) leaves the chip in flow inside the dock row.
 */
export function heroRowFor(anchor: HTMLElement): Element | null {
  const outlet = anchor.parentElement
  const row = outlet?.previousElementSibling ?? null
  if (outlet === null || row === null) return null
  const display = getComputedStyle(outlet).display
  if (display !== 'contents' && display !== 'inline') return null
  const rect = row.getBoundingClientRect()
  if (rect.width <= 0 || rect.height < 24 || rect.height > 40) return null
  return row.querySelector('button') === null ? null : row
}

/**
 * Whether `anchor` is lifted out of the dock row: a shell that keeps the dock
 * inline (no hero row above it) renders the chip there instead.
 */
export function shouldProbeInFlow(anchor: HTMLElement): boolean {
  return getComputedStyle(anchor).position === 'static'
}

/**
 * Place the chip just after the hero row's rightmost painted chip, vertically
 * centred in the row (the row is 28px tall, so the offsets coincide).
 * @param block - the anchor's containing block.
 * @param row - the official hero chip row.
 * @param paintedRight - the row's rightmost painted descendant edge.
 */
export function heroPlacementIn(block: HeroBlockBox, row: HeroRowBox, paintedRight: number): HeroPlacement {
  return {
    left: Math.max(0, paintedRight - block.left - block.clientLeft + HERO_CHIP_GAP),
    top: Math.max(0, row.top - block.top - block.clientTop + (row.height - HERO_CHIP_HEIGHT) / 2),
  }
}