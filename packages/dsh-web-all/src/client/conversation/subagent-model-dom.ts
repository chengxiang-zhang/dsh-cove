/**
 * Position-owned DOM presentation for subagent model badges. The conversation
 * module is the only owner of this augmentation; the 0.2 fact resolution stays
 * under src/core/subagent-model.
 *
 * Badge text now comes from the sessions list snapshot (each child row's
 * `modelSelection` projection), so a scan is a single synchronous pass: rows
 * whose text matches a known child label get the badge, rows without a known
 * model are simply left alone.
 */
import css from './conversation.module.css'

export const SUBAGENT_MODEL_PLUGIN = 'subagent-model'
export const SUBAGENT_MODEL_PART = 'badge'

export interface SubagentBadgeDeps {
  /** Child label (or row title) → child session id. */
  readonly labels: ReadonlyMap<string, string>
  /** Child session id → rendered `model` or `model · effort`. */
  readonly models: ReadonlyMap<string, string>
  readonly ariaLabel: (modelAndEffort: string) => string
}

const BADGE_SELECTOR = `[data-dsh-plugin="${SUBAGENT_MODEL_PLUGIN}"]`
const TOOL_ROW_PREFIX = 'Tool call subagent'
const CATALOG_ROLE = 'treeitem'

/** Augment catalog rows and all tool rows beneath root. */
export function scanSubagentRows(root: ParentNode, deps: SubagentBadgeDeps): void {
  scanSubagentCatalogRows(root, deps)
  if (deps.labels.size === 0) return
  const pattern = compileLabelPattern(deps.labels)
  const seen = new Set<string>()
  for (const child of elementChildren(root)) {
    walkToolRows(child, deps, pattern, seen)
  }
}

/** Augment only structured subagent catalog rows. */
export function scanSubagentCatalogRows(root: ParentNode, deps: SubagentBadgeDeps): void {
  if (deps.labels.size === 0) return
  const pattern = compileLabelPattern(deps.labels)
  let rows: NodeListOf<Element>
  try {
    rows = root.querySelectorAll(`[role="${CATALOG_ROLE}"]`)
  } catch {
    return
  }
  for (const row of Array.from(rows)) {
    try {
      const text = row.textContent ?? ''
      if (!text.includes('·') && !text.includes('tok')) continue
      const childId = matchChildId(text, deps.labels, pattern)
      if (childId === undefined) continue
      const metrics = row.querySelector('[class*="metrics"]')
      const labelNode = row.querySelector('[class*="label"]')
      const anchor = metrics ?? labelNode?.parentElement ?? row
      handleRow(row, anchor, childId, deps)
    } catch {
      // One malformed row must not break progressive enhancement.
    }
  }
}

/** Augment tool-call rows inside a mutation-affected subtree. */
export function scanSubagentToolRows(root: ParentNode, deps: SubagentBadgeDeps): void {
  if (deps.labels.size === 0) return
  const pattern = compileLabelPattern(deps.labels)
  const seen = new Set<string>()
  for (const child of elementChildren(root)) {
    walkToolRows(child, deps, pattern, seen)
  }
}

function elementChildren(root: ParentNode): Element[] {
  if (root instanceof Element) return [root]
  if ('children' in root) return Array.from(root.children)
  return []
}

function walkToolRows(
  node: Element,
  deps: SubagentBadgeDeps,
  pattern: RegExp,
  seen: Set<string>,
): boolean {
  let descendantMatched = false
  for (const child of Array.from(node.children)) {
    if (walkToolRows(child, deps, pattern, seen)) descendantMatched = true
  }
  if (descendantMatched) return true
  const text = node.textContent ?? ''
  if (!text.includes(TOOL_ROW_PREFIX)) return false
  const childId = matchChildId(text, deps.labels, pattern)
  if (childId === undefined) return false
  handleRow(node, node, childId, deps)
  seen.add(childId)
  return true
}

function handleRow(
  row: Element,
  anchor: Element,
  childId: string,
  deps: SubagentBadgeDeps,
): void {
  const text = deps.models.get(childId)
  // No projection value yet: leave whatever is already rendered in place.
  if (text === undefined) return
  const existing = row.querySelector<HTMLElement>(BADGE_SELECTOR)
  if (existing !== null) {
    existing.textContent = text
    existing.title = text
    existing.setAttribute('aria-label', deps.ariaLabel(text))
    return
  }
  const badge = document.createElement('span')
  badge.className = css.subagentModelBadge ?? ''
  badge.textContent = text
  badge.title = text
  badge.setAttribute('aria-label', deps.ariaLabel(text))
  badge.setAttribute('data-dsh-plugin', SUBAGENT_MODEL_PLUGIN)
  badge.setAttribute('data-dsh-part', SUBAGENT_MODEL_PART)
  anchor.appendChild(badge)
}

function compileLabelPattern(labels: ReadonlyMap<string, string>): RegExp {
  const alternatives = [...labels.keys()]
    .filter(label => label.length > 0)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
  return alternatives.length === 0
    ? /(?!)/g
    : new RegExp(`(?:${alternatives.join('|')})`, 'g')
}

function matchChildId(
  text: string,
  labels: ReadonlyMap<string, string>,
  pattern: RegExp,
): string | undefined {
  pattern.lastIndex = 0
  let best: string | undefined
  let bestLabel: string | undefined
  for (const match of text.matchAll(pattern)) {
    const candidate = match[0]
    if (labels.has(candidate) && (bestLabel === undefined || candidate.length > bestLabel.length)) {
      bestLabel = candidate
      best = labels.get(candidate)
    }
  }
  return best
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}