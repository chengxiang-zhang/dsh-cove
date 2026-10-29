/**
 * Conversation-owned subagent model surface.
 *
 * It augments already-rendered catalog/tool rows with each child's model and
 * reasoning effort, read from the sessions list snapshot's `modelSelection`
 * projection (DSH 0.2). Nothing is fetched and no child session is opened or
 * retained: the rows the badge targets are rendered by the official UI, and the
 * projections that describe them travel with the same list snapshot.
 *
 * The conversation position is a root scope, so the current session comes from
 * the public `uiSession.adapter.current` binding (the private `uiSession.current`
 * and the workspace selection cell remain as fallbacks for older cohorts).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import {
  resolveSubagentBadges,
  type SubagentListSnapshotLike,
} from '../../core/subagent-model/badges.ts'
import {
  scanSubagentCatalogRows,
  scanSubagentRows,
  scanSubagentToolRows,
} from './subagent-model-dom.ts'
import { NS, type ConversationLocaleKey } from './index.ts'

const SCAN_DEBOUNCE_MS = 300

/** A useSyncExternalStore-compatible source (cordis binding source or snapshot store). */
interface SnapshotSource<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** The selection faces the conversation root may read for "the session I am in". */
interface SelectionFaces {
  uiSession?: {
    adapter?: { current?: SnapshotSource<{ key?: string } | undefined> }
    current?: SnapshotSource<{ key?: string } | undefined>
  }
  uiWorkspace?: { selection?: SnapshotSource<{ sessionId?: string } | undefined> }
}

const zh = {
  'subagentModel.badge.aria': '子代理模型与推理深度 {model}',
} as const

const en: Record<keyof typeof zh, string> = {
  'subagentModel.badge.aria': 'Subagent model and reasoning effort {model}',
}

/** Take one optional service without requiring it in the plugin's inject list. */
function optionalService<T>(ctx: ClientContext, name: string): T | undefined {
  try {
    return (ctx.get as unknown as (id: string, strict?: boolean) => unknown)(name, false) as T | undefined
  } catch {
    return undefined
  }
}

/** Read a source without letting a hostile or proxied face throw. */
function read<T>(reader: () => T): T | undefined {
  try {
    return reader()
  } catch {
    return undefined
  }
}

/** The session the operator is in: public adapter binding first. */
function currentSessionId(faces: SelectionFaces): string | undefined {
  const candidates = [
    read(() => faces.uiSession?.adapter?.current?.getSnapshot()?.key),
    read(() => faces.uiSession?.current?.getSnapshot()?.key),
    read(() => faces.uiWorkspace?.selection?.getSnapshot()?.sessionId),
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/** Mount the read-only model badge observer within the conversation position. */
export function mountSubagentModel(ctx: ClientContext): () => void {
  const sessions = optionalService<ISessions>(ctx, 'sessions')
  if (sessions === undefined || typeof sessions.list?.subscribe !== 'function') return () => {}
  const disposers: Array<() => void> = []

  try {
    disposers.push(ctx.locale.register(NS, { zh, en }))
  } catch {
    // A duplicate namespace registration must not break the web shell.
  }
  const translate = ctx.locale.bind(NS)
  const ariaLabel = (value: string): string => translate(
    'subagentModel.badge.aria' as ConversationLocaleKey,
    { model: value },
  )

  const labels = new Map<string, string>()
  const models = new Map<string, string>()
  const dirtyRoots = new Set<Element>()
  let scanTimer: ReturnType<typeof setTimeout> | undefined
  let idleHandle: number | undefined
  let fullScanPending = true

  /** The selection faces, re-read per scan so a late service is picked up. */
  const selectionFaces = (): SelectionFaces => ({
    uiSession: optionalService<SelectionFaces['uiSession']>(ctx, 'uiSession'),
    uiWorkspace: optionalService<SelectionFaces['uiWorkspace']>(ctx, 'uiWorkspace'),
  })

  /** Project the list snapshot into the DOM matcher's two maps. */
  const rebuild = (): void => {
    labels.clear()
    models.clear()
    const snapshot = sessions.list.getSnapshot() as unknown as SubagentListSnapshotLike
    const { badges } = resolveSubagentBadges(snapshot, currentSessionId(selectionFaces()))
    for (const badge of badges) {
      for (const label of badge.labels) labels.set(label, badge.childId)
      if (badge.modelText !== undefined) models.set(badge.childId, badge.modelText)
    }
  }

  const scheduleScan = (): void => {
    if (scanTimer !== undefined) clearTimeout(scanTimer)
    scanTimer = setTimeout(() => {
      scanTimer = undefined
      const requestIdle = (globalThis as {
        requestIdleCallback?: (callback: () => void) => number
      }).requestIdleCallback
      if (typeof requestIdle === 'function') {
        idleHandle = requestIdle(() => { runScan() })
      } else {
        runScan()
      }
    }, SCAN_DEBOUNCE_MS)
  }

  function runScan(): void {
    if (typeof document === 'undefined' || document.body === null) return
    try {
      rebuild()
      const deps = { labels, models, ariaLabel }
      if (fullScanPending) scanSubagentRows(document.body, deps)
      else scanSubagentCatalogRows(document.body, deps)
      fullScanPending = false
      for (const root of dirtyRoots) {
        if (!root.isConnected) continue
        scanSubagentToolRows(root, deps)
      }
      dirtyRoots.clear()
    } catch {
      // The badge is progressive enhancement and never blocks the shell.
    }
  }

  if (typeof document !== 'undefined' && document.body !== null && typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const nodes = record.addedNodes.length > 0 ? record.addedNodes : [record.target]
        for (const node of Array.from(nodes)) {
          const element = node instanceof Element ? node : node.parentElement
          if (element === null) continue
          dirtyRoots.add(element)
          while (dirtyRoots.size > 32) {
            const oldest = dirtyRoots.values().next().value
            if (oldest === undefined) break
            dirtyRoots.delete(oldest)
          }
        }
      }
      scheduleScan()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    const unsubscribe = sessions.list.subscribe(() => {
      fullScanPending = true
      scheduleScan()
    })
    scheduleScan()
    disposers.push(() => {
      observer.disconnect()
      unsubscribe()
      if (scanTimer !== undefined) clearTimeout(scanTimer)
      if (idleHandle !== undefined) {
        const cancelIdle = (globalThis as {
          cancelIdleCallback?: (handle: number) => void
        }).cancelIdleCallback
        cancelIdle?.(idleHandle)
      }
    })
  }

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}