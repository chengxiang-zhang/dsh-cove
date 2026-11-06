/**
 * 记忆主栏页面（只读产品面）。
 *
 * 两个标签页对应两个作用域：全局（`viking://user/<user>/memories/`）与工作区
 * （当前仓库 peer 下的记忆）。每个标签页都是「面包屑 + 目录列表 + 目录下钻 +
 * 文件预览 + 全文检索」，数据全部来自宿主代理的只读接口，页面不落任何本地
 * 存储，也不写回记忆 —— 它只是 OpenViking 已有记忆的另一个视图。
 *
 * 面板是全局 `main` 面板，没有注入的会话身份：当前工作目录由位置模块传入的
 * 跟踪器解析（见 cwd.ts），解析不出时照常取数，宿主会报 `source: 'unknown'`；
 * 工作区不在 git 仓库时宿主把记忆退回全局空间，页面用提示行说明，并给一个
 * 「查看全局」的出口，任何情况下都不会只剩一条死路。
 *
 * 版心、页头与提示行复用 page-shell（与官方插件页同形）；Markdown 用本地
 * 分块器（markdown.ts）按纯文本渲染，既不引依赖，也不用 innerHTML。
 */
import { Fragment, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { MemoryApi } from './api.ts'
import type { MemoryCwdTracker } from './cwd.ts'
import { errorText, tt, type MemoryKey } from './locales.ts'
import { splitMarkdownBlocks, type MarkdownBlock } from './markdown.ts'
import {
  compareMemoryNodes,
  uriRelativeTo,
  type MemoryDocument,
  type MemoryError,
  type MemoryHit,
  type MemoryListing,
  type MemoryNode,
  type MemoryScope,
  type MemorySearchResult,
  type MemoryStatus,
  type MemoryWorkspaceState,
} from '../../../../core/memory-view/protocol.ts'
import { PageNotice, PageSection, PageShell } from '../../page-shell.tsx'
import css from './panel.module.css'

/** 标签页顺序（全局在前：跨仓库记忆是缺省视图）。 */
const SCOPES: readonly MemoryScope[] = ['global', 'workspace']

/** 标签页文案 key。 */
const SCOPE_LABEL: Record<MemoryScope, MemoryKey> = { global: 'tab.global', workspace: 'tab.workspace' }

/** 工作区 peer 来源的文案 key。 */
const WORKSPACE_SOURCE_LABEL: Record<MemoryWorkspaceState['source'], MemoryKey> = {
  'git-remote': 'workspace.source.gitRemote',
  'git-root': 'workspace.source.gitRoot',
  none: 'workspace.source.none',
  unknown: 'workspace.source.unknown',
}

/** 面板属性：位置模块注入取数面与 cwd 跟踪器（面板本身不碰 ctx）。 */
export interface MemoryPanelProps {
  /** 记忆只读接口。 */
  api: MemoryApi
  /** 当前工作区 cwd 的跟踪器（可观察，随选择变化刷新）。 */
  cwd: MemoryCwdTracker
}

/** 页面级状态。 */
type StatusState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: MemoryStatus }
  | { kind: 'error'; error: MemoryError }

/** 目录列举状态。 */
type ListingState =
  | { kind: 'loading' }
  | { kind: 'ready'; listing: MemoryListing }
  | { kind: 'error'; error: MemoryError }

/** 检索状态。 */
type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; result: MemorySearchResult }
  | { kind: 'error'; error: MemoryError }

/** 预览状态。 */
type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; document: MemoryDocument }
  | { kind: 'error'; error: MemoryError }

/** 当前预览目标。 */
interface Selection {
  uri: string
  name: string
}

/** 任意抛出值折成失败体（取数面承诺不抛，这里只做最后一层兜底）。 */
function reasonError(cause: unknown): MemoryError {
  const message = cause instanceof Error ? cause.message : String(cause)
  return { code: 'unreachable', message }
}

/** 文件大小的本地化文案。 */
function formatSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return tt('size.bytes', { value: 0 })
  if (size < 1024) return tt('size.bytes', { value: size })
  if (size < 1024 * 1024) return tt('size.kib', { value: (size / 1024).toFixed(1) })
  if (size < 1024 * 1024 * 1024) return tt('size.mib', { value: (size / (1024 * 1024)).toFixed(1) })
  return tt('size.gib', { value: (size / (1024 * 1024 * 1024)).toFixed(1) })
}

/** 目录 URI 相对根的路径段（面包屑用）；根上返回空数组。 */
function crumbSegments(listing: MemoryListing): string[] {
  const relative = uriRelativeTo(listing.uri, listing.root)
  if (relative === null || relative === '') return []
  return relative.split('/').filter((segment) => segment !== '')
}

/** 订阅 cwd 跟踪器，返回当前工作目录（解析不出时 `''`）。 */
function useTrackedCwd(tracker: MemoryCwdTracker): string {
  const subscribe = useCallback((listener: () => void) => tracker.subscribe(listener), [tracker])
  return useSyncExternalStore(subscribe, () => tracker.getSnapshot(), () => '')
}

/** 记忆页面。 */
export function MemoryPanel({ api, cwd: cwdTracker }: MemoryPanelProps): JSX.Element {
  const cwd = useTrackedCwd(cwdTracker)
  const cwdParam = cwd === '' ? undefined : cwd
  const [scope, setScope] = useState<MemoryScope>('global')
  const [paths, setPaths] = useState<Record<MemoryScope, string>>({ global: '', workspace: '' })
  const [reload, setReload] = useState(0)
  const [status, setStatus] = useState<StatusState>({ kind: 'loading' })

  useEffect(() => {
    let alive = true
    setStatus({ kind: 'loading' })
    void api.status(cwdParam).then((envelope) => {
      if (!alive) return
      setStatus(envelope.ok ? { kind: 'ready', status: envelope.value } : { kind: 'error', error: envelope.error })
    }).catch((cause: unknown) => {
      if (alive) setStatus({ kind: 'error', error: reasonError(cause) })
    })
    return () => { alive = false }
  }, [api, cwdParam, reload])

  const refresh = useCallback(() => { setReload((value) => value + 1) }, [])
  const navigate = useCallback((next: string) => {
    setPaths((previous) => (previous[scope] === next ? previous : { ...previous, [scope]: next }))
  }, [scope])

  const ready = status.kind === 'ready' ? status.status : undefined
  const connected = ready !== undefined && ready.connection.connected
  const retryAction = (
    <button type="button" className={css.linkButton} onClick={refresh}>{tt('common.retry')}</button>
  )

  return (
    <PageShell
      plugin="memory"
      title={tt('panel.title')}
      intro={tt('panel.intro')}
      busy={status.kind === 'loading'}
      toolbar={<button type="button" className={css.button} onClick={refresh}>{tt('panel.refresh')}</button>}
    >
      <PageSection>
        <div className={css.tabBar} role="tablist">
          {SCOPES.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              className={css.tab}
              aria-selected={scope === item}
              data-active={scope === item ? '' : undefined}
              data-dsh-part="tab"
              onClick={() => { setScope(item) }}
            >
              {tt(SCOPE_LABEL[item])}
            </button>
          ))}
        </div>
      </PageSection>
      <PageSection fill>
        {status.kind === 'loading' ? <PageNotice kind="loading">{tt('common.loading')}</PageNotice> : null}
        {status.kind === 'error' ? (
          <PageNotice kind="error" action={retryAction}>{errorText(status.error.code)}</PageNotice>
        ) : null}
        {ready !== undefined && !connected ? (
          <PageNotice kind="error" action={retryAction}>
            <span>{tt('status.disconnected', { server: ready.connection.server })}</span>
            {ready.connection.error === undefined || ready.connection.error === ''
              ? null
              : <span className={css.detail}>{ready.connection.error}</span>}
          </PageNotice>
        ) : null}
        {ready !== undefined && connected ? (
          <MemoryScopeView
            key={scope}
            api={api}
            scope={scope}
            cwd={cwdParam}
            path={paths[scope]}
            workspace={ready.workspace}
            reload={reload}
            onNavigate={navigate}
            onSwitchScope={setScope}
          />
        ) : null}
      </PageSection>
    </PageShell>
  )
}

/** 一个作用域的浏览视图（标签页切换即重建，目录路径由父级保管）。 */
interface MemoryScopeViewProps {
  api: MemoryApi
  scope: MemoryScope
  cwd: string | undefined
  path: string
  workspace: MemoryWorkspaceState
  reload: number
  onNavigate: (path: string) => void
  onSwitchScope: (scope: MemoryScope) => void
}

/** 作用域浏览：面包屑 + 列表/检索结果 + 预览。 */
function MemoryScopeView({ api, scope, cwd, path, workspace, reload, onNavigate, onSwitchScope }: MemoryScopeViewProps): JSX.Element {
  const [listing, setListing] = useState<ListingState>({ kind: 'loading' })
  const [selection, setSelection] = useState<Selection | null>(null)
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' })
  const [input, setInput] = useState('')
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' })
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let alive = true
    setListing({ kind: 'loading' })
    void api.list({ scope, path, cwd }).then((envelope) => {
      if (!alive) return
      setListing(envelope.ok ? { kind: 'ready', listing: envelope.value } : { kind: 'error', error: envelope.error })
    }).catch((cause: unknown) => {
      if (alive) setListing({ kind: 'error', error: reasonError(cause) })
    })
    return () => { alive = false }
  }, [api, scope, path, cwd, reload, retry])

  useEffect(() => {
    if (submitted === null) {
      setSearch({ kind: 'idle' })
      return
    }
    let alive = true
    setSearch({ kind: 'loading' })
    void api.search({ query: submitted, scope, cwd }).then((envelope) => {
      if (!alive) return
      setSearch(envelope.ok ? { kind: 'ready', result: envelope.value } : { kind: 'error', error: envelope.error })
    }).catch((cause: unknown) => {
      if (alive) setSearch({ kind: 'error', error: reasonError(cause) })
    })
    return () => { alive = false }
  }, [api, scope, cwd, submitted, reload, retry])

  useEffect(() => {
    if (selection === null) {
      setPreview({ kind: 'idle' })
      return
    }
    let alive = true
    setPreview({ kind: 'loading' })
    void api.read(selection.uri, cwd).then((envelope) => {
      if (!alive) return
      setPreview(envelope.ok ? { kind: 'ready', document: envelope.value } : { kind: 'error', error: envelope.error })
    }).catch((cause: unknown) => {
      if (alive) setPreview({ kind: 'error', error: reasonError(cause) })
    })
    return () => { alive = false }
  }, [api, cwd, selection, reload, retry])

  const blocks = useMemo(
    () => (preview.kind === 'ready' ? splitMarkdownBlocks(preview.document.text) : []),
    [preview],
  )

  const backToRoot = useCallback(() => {
    setSelection(null)
    onNavigate('')
  }, [onNavigate])

  const rerun = useCallback(() => { setRetry((value) => value + 1) }, [])
  const retryAction = <button type="button" className={css.linkButton} onClick={rerun}>{tt('common.retry')}</button>

  const openNode = useCallback((node: MemoryNode) => {
    if (!node.isDir) {
      setSelection({ uri: node.uri, name: node.name })
      return
    }
    const relative = listing.kind === 'ready' ? uriRelativeTo(node.uri, listing.listing.root) : null
    const next = relative ?? (path === '' ? node.name : `${path}/${node.name}`)
    setSelection(null)
    onNavigate(next)
  }, [listing, path, onNavigate])

  const openHit = useCallback((hit: MemoryHit) => { setSelection({ uri: hit.uri, name: hit.name }) }, [])
  const closePreview = useCallback(() => { setSelection(null) }, [])
  const clearSearch = useCallback(() => { setInput(''); setSubmitted(null) }, [])

  const searching = submitted !== null
  const nodes = listing.kind === 'ready' ? [...listing.listing.nodes].sort(compareMemoryNodes) : []
  const segments = listing.kind === 'ready' ? crumbSegments(listing.listing) : []

  return (
    <div className={css.scopeBody}>
      {scope === 'workspace' ? <WorkspaceLine workspace={workspace} onSwitchScope={onSwitchScope}/> : null}
      <div className={css.toolbarRow}>
        {listing.kind === 'ready' && !searching ? (
          <nav className={css.crumbs} data-dsh-part="crumb" aria-label={tt('crumb.label')}>
            <button type="button" className={css.crumb} title={listing.listing.root} onClick={backToRoot}>
              {tt(SCOPE_LABEL[scope])}
            </button>
            {segments.map((segment, index) => {
              const target = segments.slice(0, index + 1).join('/')
              const last = index === segments.length - 1
              return (
                <Fragment key={target}>
                  <span className={css.crumbSeparator} aria-hidden="true">/</span>
                  <button
                    type="button"
                    className={css.crumb}
                    data-active={last ? '' : undefined}
                    onClick={() => { if (!last) { setSelection(null); onNavigate(target) } }}
                  >
                    {segment}
                  </button>
                </Fragment>
              )
            })}
          </nav>
        ) : null}
        <form
          className={css.search}
          data-dsh-part="search"
          onSubmit={(event) => {
            event.preventDefault()
            const text = input.trim()
            setSubmitted(text === '' ? null : text)
          }}
        >
          <input
            className={css.searchInput}
            type="search"
            value={input}
            aria-label={tt('search.label')}
            placeholder={tt('search.placeholder')}
            onChange={(event) => { setInput(event.target.value) }}
          />
          <button type="submit" className={css.button}>{tt('search.submit')}</button>
          {searching ? <button type="button" className={css.linkButton} onClick={clearSearch}>{tt('search.clear')}</button> : null}
        </form>
      </div>
      <div className={css.split} data-preview={selection === null ? undefined : ''}>
        <div className={css.listColumn}>
          {searching && (search.kind === 'idle' || search.kind === 'loading')
            ? <PageNotice kind="loading">{tt('common.loading')}</PageNotice>
            : null}
          {searching && search.kind === 'error' ? (
            <PageNotice kind="error" action={retryAction}>{errorText(search.error.code)}</PageNotice>
          ) : null}
          {searching && search.kind === 'ready' ? (
            search.result.hits.length === 0 ? (
              <PageNotice kind="empty">{tt('search.empty')}</PageNotice>
            ) : (
              <>
                <p className={css.resultsLine}>{tt('search.results', { count: search.result.hits.length })}</p>
                <MemoryHits hits={search.result.hits} selection={selection} onOpen={openHit}/>
              </>
            )
          ) : null}
          {!searching && listing.kind === 'loading' ? <PageNotice kind="loading">{tt('common.loading')}</PageNotice> : null}
          {!searching && listing.kind === 'error' ? (
            <PageNotice
              kind="error"
              action={
                <>
                  {retryAction}
                  {path === '' ? null : (
                    <button type="button" className={css.linkButton} onClick={backToRoot}>{tt('list.backToRoot')}</button>
                  )}
                </>
              }
            >
              {errorText(listing.error.code)}
            </PageNotice>
          ) : null}
          {!searching && listing.kind === 'ready' ? (
            nodes.length === 0
              ? <PageNotice kind="empty">{tt('list.empty')}</PageNotice>
              : <MemoryRows nodes={nodes} selection={selection} onOpen={openNode}/>
          ) : null}
        </div>
        {selection === null ? null : (
          <MemoryPreview selection={selection} state={preview} blocks={blocks} onClose={closePreview}/>
        )}
      </div>
    </div>
  )
}

/** 工作区身份行：解析出 peer 时展示 peer，否则给出退回全局空间的提示与出口。 */
function WorkspaceLine({ workspace, onSwitchScope }: {
  workspace: MemoryWorkspaceState
  onSwitchScope: (scope: MemoryScope) => void
}): JSX.Element {
  const source = WORKSPACE_SOURCE_LABEL[workspace.source]
  if (workspace.peer !== null && workspace.peer !== '') {
    return (
      <p className={css.scopeLine}>
        <span className={css.scopePeer} title={workspace.cwd ?? undefined}>{tt('workspace.peer', { peer: workspace.peer })}</span>
        <span className={css.detail}>{tt(source)}</span>
      </p>
    )
  }
  return (
    <p className={css.scopeLine}>
      <span>{workspace.cwd === null ? tt('workspace.noCwd') : tt('workspace.noPeer')}</span>
      <span className={css.detail}>{tt(source)}</span>
      <button type="button" className={css.linkButton} onClick={() => { onSwitchScope('global') }}>
        {tt('workspace.openGlobal')}
      </button>
    </p>
  )
}

/** 目录列表行：目录在前（宿主与本地排序都成立），点目录下钻、点文件预览。 */
function MemoryRows({ nodes, selection, onOpen }: {
  nodes: readonly MemoryNode[]
  selection: Selection | null
  onOpen: (node: MemoryNode) => void
}): JSX.Element {
  return (
    <ul className={css.list}>
      {nodes.map((node) => (
        <li key={node.uri}>
          <button
            type="button"
            className={css.row}
            data-dsh-part="row"
            data-kind={node.isDir ? 'dir' : 'file'}
            data-active={selection?.uri === node.uri ? '' : undefined}
            onClick={() => { onOpen(node) }}
          >
            <span className={css.rowName}>{node.name}</span>
            <span className={css.rowMeta}>{node.isDir ? tt('list.directory') : formatSize(node.size)}</span>
            {node.abstract === undefined || node.abstract === '' ? null : (
              <span className={css.rowAbstract}>{node.abstract}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** 检索命中行。 */
function MemoryHits({ hits, selection, onOpen }: {
  hits: readonly MemoryHit[]
  selection: Selection | null
  onOpen: (hit: MemoryHit) => void
}): JSX.Element {
  return (
    <ul className={css.list}>
      {hits.map((hit) => (
        <li key={hit.uri}>
          <button
            type="button"
            className={css.row}
            data-dsh-part="row"
            data-kind="hit"
            data-active={selection?.uri === hit.uri ? '' : undefined}
            onClick={() => { onOpen(hit) }}
          >
            <span className={css.rowName}>{hit.name}</span>
            <span className={css.rowMeta}>{tt('search.score', { score: hit.score.toFixed(2) })}</span>
            <span className={css.rowAbstract}>{hit.abstract}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** 文档预览：标题 + 块级渲染（纯文本，永不注入 HTML）。 */
function MemoryPreview({ selection, state, blocks, onClose }: {
  selection: Selection
  state: PreviewState
  blocks: readonly MarkdownBlock[]
  onClose: () => void
}): JSX.Element {
  return (
    <section className={css.preview} data-dsh-part="preview" aria-label={tt('preview.title')}>
      <div className={css.previewHead}>
        <h2 className={css.previewTitle} title={selection.uri}>{selection.name}</h2>
        <button type="button" className={css.linkButton} onClick={onClose}>{tt('preview.close')}</button>
      </div>
      {state.kind === 'loading' || state.kind === 'idle' ? <PageNotice kind="loading">{tt('common.loading')}</PageNotice> : null}
      {state.kind === 'error' ? <PageNotice kind="error">{errorText(state.error.code)}</PageNotice> : null}
      {state.kind === 'ready' ? <MemoryBlocks blocks={blocks}/> : null}
    </section>
  )
}

/** 块级 Markdown 渲染：每个块都是 React 文本节点，不解释行内语法。 */
function MemoryBlocks({ blocks }: { blocks: readonly MarkdownBlock[] }): JSX.Element {
  return (
    <div className={css.markdown}>
      {blocks.map((block, index) => {
        const key = String(index)
        if (block.kind === 'heading') {
          return (
            <div key={key} className={css.mdHeading} role="heading" aria-level={block.level} data-level={block.level}>
              {block.text}
            </div>
          )
        }
        if (block.kind === 'code') {
          return <pre key={key} className={css.mdCode}><code>{block.text}</code></pre>
        }
        if (block.kind === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul'
          return (
            <Tag key={key} className={css.mdList}>
              {block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{item}</li>)}
            </Tag>
          )
        }
        if (block.kind === 'quote') {
          return <blockquote key={key} className={css.mdQuote}>{block.text}</blockquote>
        }
        return <p key={key} className={css.mdParagraph}>{block.text}</p>
      })}
    </div>
  )
}