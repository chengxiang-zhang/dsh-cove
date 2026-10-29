

/** One `projectionValues` bag as the client list carries it. */
export interface SubagentProjectionValuesLike {
  readonly subagentCatalog?: unknown
  readonly modelSelection?: unknown
}

/** The subset of a session list row this resolver reads. */
export interface SubagentListRowLike {
  readonly id?: unknown
  readonly parentId?: unknown
  readonly origin?: unknown
  readonly displayTitle?: unknown
  readonly title?: unknown
  readonly projectionValues?: SubagentProjectionValuesLike
}

/** The subset of the sessions list snapshot this resolver reads. */
export interface SubagentListSnapshotLike {
  readonly byId?: Readonly<Record<string, SubagentListRowLike>>
  /** Parent-keyed projections; a fallback path for the catalog. */
  readonly projectionsBySession?: Readonly<Record<string, { readonly values?: { readonly subagentCatalog?: unknown } }>>
}

/** One badge to render: the child identity, its matchable labels, and its text. */
export interface SubagentBadgeFacts {
  readonly childId: string
  /** Labels/row titles that identify this child's rendered row. */
  readonly labels: readonly string[]
  /** `model` or `model · effort`; absent when the child recorded no selection. */
  readonly modelText?: string
}

/** Resolved badges plus the conversation root they belong to. */
export interface SubagentBadgeResolution {
  readonly rootId?: string
  readonly badges: readonly SubagentBadgeFacts[]
}

/**
 * Walk upward to the first non-subagent session.
 * @param rows - the list rows.
 * @param sessionId - any listed session id.
 * @returns the root conversation's id (the input when it is already a root).
 */
export function rootSessionId(
  rows: Readonly<Record<string, SubagentListRowLike>>,
  sessionId: string,
): string {
  const seen = new Set<string>()
  let current = rows[sessionId]
  while (current?.origin === 'subagent' && typeof current.parentId === 'string' && !seen.has(String(current.id))) {
    seen.add(String(current.id))
    current = rows[current.parentId]
  }
  return typeof current?.id === 'string' ? current.id : sessionId
}

/** `model` or `model · effort`, or undefined when the choice carries no model. */
export function formatModelText(choice: unknown): string | undefined {
  if (!isRecord(choice)) return undefined
  const model = nonBlankString(choice.model)
  if (model === undefined) return undefined
  const effort = nonBlankString(choice.reasoningEffort)
  return effort === undefined ? model : `${model} · ${effort}`
}

/**
 * Resolve every badge for the conversation the operator is in.
 * @param snapshot - the sessions list snapshot (`byId` + projections).
 * @param sessionId - the main-view session id, when one is selected.
 * @returns the root id and one entry per catalog child that has a model.
 */
export function resolveSubagentBadges(
  snapshot: SubagentListSnapshotLike,
  sessionId: string | undefined,
): SubagentBadgeResolution {
  const rows = snapshot.byId ?? {}
  if (sessionId === undefined || sessionId === '') return { badges: [] }
  const rootId = rootSessionId(rows, sessionId)
  const catalog = readCatalog(snapshot, rows, rootId)
  const badges: SubagentBadgeFacts[] = []
  const seen = new Set<string>()
  for (const entry of catalog) {
    const childId = readChildId(entry)
    if (childId === undefined || seen.has(childId)) continue
    seen.add(childId)
    const child = rows[childId]
    badges.push({
      childId,
      labels: childLabels(entry, child),
      ...(formatModelText(pickSelection(child?.projectionValues?.modelSelection)) === undefined
        ? {}
        : { modelText: formatModelText(pickSelection(child?.projectionValues?.modelSelection)) }),
    })
  }
  return { rootId, badges }
}

/** The parent row's catalog first; the parent-keyed projection as fallback. */
function readCatalog(
  snapshot: SubagentListSnapshotLike,
  rows: Readonly<Record<string, SubagentListRowLike>>,
  rootId: string,
): readonly unknown[] {
  const fromRow = rows[rootId]?.projectionValues?.subagentCatalog
  if (Array.isArray(fromRow)) return fromRow
  const fromProjection = snapshot.projectionsBySession?.[rootId]?.values?.subagentCatalog
  return Array.isArray(fromProjection) ? fromProjection : []
}

function readChildId(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined
  return nonBlankString(entry.id)
}

/** Every label a rendered row may carry for this child. */
function childLabels(entry: unknown, child: SubagentListRowLike | undefined): readonly string[] {
  const candidates = [
    isRecord(entry) ? nonBlankString(entry.label) : undefined,
    nonBlankString(child?.displayTitle),
    nonBlankString(child?.title),
  ]
  return [...new Set(candidates.filter((value): value is string => value !== undefined))]
}

/** The committed request header wins over the pending intent. */
function pickSelection(selection: unknown): unknown {
  if (!isRecord(selection)) return selection
  return selection.lastUsed ?? selection.next
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function nonBlankString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}