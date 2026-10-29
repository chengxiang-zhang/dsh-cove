/** VSCode-style unified-diff surface for the Git management page: per-file
 *  sections with hunks, old/new line-number gutters, added/deleted/renamed/
 *  binary tags, source files expanded by default, and a hard row cap so a
 *  huge patch never freezes the sidebar. The parser is a pure function so the
 *  interesting cases are unit-tested without a DOM. */
import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { rightPaneEn, type RightPaneLocaleKey } from './right-pane-i18n.ts'
import css from './sidebar.module.css'

/** One rendered diff line. */
export interface DiffLine {
  kind: 'ctx' | 'del' | 'add' | 'meta'
  /** The line content without its diff marker ('' for the no-newline marker). */
  text: string
  /** Old-side line number (null for pure additions / metadata). */
  oldNum: number | null
  /** New-side line number (null for pure deletions / metadata). */
  newNum: number | null
}

/** One parsed hunk. */
export interface DiffHunk {
  /** The old-side start line (`-a[,b]`). */
  oldStart: number
  /** The new-side start line (`+c[,d]`). */
  newStart: number
  /** The section text after the trailing `@@` (may be empty). */
  header: string
  lines: DiffLine[]
}

/** One parsed file section of a unified diff. */
export interface DiffFile {
  /** The `---` path verbatim ('/dev/null' for a new file). */
  oldPath: string
  /** The `+++` path verbatim ('/dev/null' for a deleted file). */
  newPath: string
  /** The file changed with binary content: no hunks to draw. */
  binary: boolean
  hunks: DiffHunk[]
}

/** The parsed unified diff. */
export interface ParsedDiff {
  files: DiffFile[]
}

/** Parse the hunk header `@@ -a[,b] +c[,d] @@ section` (section may contain '@@'). */
function parseHunkHeader(line: string): { oldStart: number; newStart: number; header: string } | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u.exec(line)
  if (match === null) return null
  return { oldStart: Number(match[1]), newStart: Number(match[3]), header: match[5] ?? '' }
}

/** Parse `git diff --no-color` output into file sections and hunks. Rows
 *  outside a file section (leading noise) and metadata rows between the
 *  `diff --git`/`---`/`+++` headers and the first hunk (index lines, mode
 *  changes, rename/similarity lines) are skipped; a section that never
 *  reaches a hunk (a mode/rename-only change) stays hunkless so the caller
 *  can still draw its path. */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let inHunk = false
  let hunk: DiffHunk | null = null
  let oldNum = 0
  let newNum = 0
  const flushHunk = (): void => {
    if (current !== null && hunk !== null) current.hunks.push(hunk)
    hunk = null
    inHunk = false
  }
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      flushHunk()
      current = { oldPath: '', newPath: '', binary: false, hunks: [] }
      files.push(current)
      continue
    }
    if (current === null) continue
    if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') {
      flushHunk()
      current.binary = true
      continue
    }
    if (raw.startsWith('--- ')) {
      flushHunk()
      current.oldPath = raw.slice(4)
      continue
    }
    if (raw.startsWith('+++ ')) {
      current.newPath = raw.slice(4)
      continue
    }
    const header = parseHunkHeader(raw)
    if (header !== null) {
      flushHunk()
      hunk = { oldStart: header.oldStart, newStart: header.newStart, header: header.header, lines: [] }
      oldNum = header.oldStart
      newNum = header.newStart
      inHunk = true
      continue
    }
    if (!inHunk || hunk === null) continue
    const marker = raw[0]
    if (marker === '\\') {
      // `\ No newline at end of file`: metadata attached to the previous row.
      hunk.lines.push({ kind: 'meta', text: raw.slice(1), oldNum: null, newNum: null })
      continue
    }
    if (marker === ' ') {
      hunk.lines.push({ kind: 'ctx', text: raw.slice(1), oldNum, newNum })
      oldNum += 1
      newNum += 1
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', text: raw.slice(1), oldNum, newNum: null })
      oldNum += 1
    } else if (marker === '+') {
      hunk.lines.push({ kind: 'add', text: raw.slice(1), oldNum: null, newNum })
      newNum += 1
    } else {
      // Not a diff line (a hunk can never contain one): stop the hunk.
      flushHunk()
    }
  }
  flushHunk()
  return { files }
}

/** Strip the `a/` / `b/` prefix git puts on diff paths (not on /dev/null). */
function displayPath(path: string): string {
  if (path === '/dev/null') return path
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2)
  return path
}

/** The file header badge: added / deleted / renamed / binary ('' for a plain edit). */
function fileTag(file: DiffFile, s: (key: RightPaneLocaleKey) => string): string | null {
  if (file.binary) return s('git.diff.binary')
  if (file.oldPath === '/dev/null') return s('git.diff.added')
  if (file.newPath === '/dev/null') return s('git.diff.deleted')
  const oldPath = displayPath(file.oldPath)
  const newPath = displayPath(file.newPath)
  if (oldPath !== newPath) return s('git.diff.renamed')
  return null
}

/** Cap the flattened rows like DiffBlock: head + tail, expand button between. */
const MAX_DIFF_ROWS = 500

const TEST_PATH = /(^|\/)(?:__tests__|tests?|specs?|fixtures?|mocks?|snapshots?)(?:\/|$)|\.(?:test|spec)\.[^/]+$/iu
const DOC_PATH = /(^|\/)(?:docs?|documentation)(?:\/|$)|(^|\/)(?:readme|changelog|contributing|license|authors|notice)(?:\.[^/]*)?$/iu
const GENERATED_PATH = /(^|\/)(?:dist|build|coverage|generated|vendor|node_modules)(?:\/|$)|(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|composer\.lock|cargo\.lock|poetry\.lock)$/iu
const SOURCE_PATH = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyw|rb|php|java|kt|kts|scala|go|rs|swift|c|h|cc|cpp|cxx|hpp|hh|hxx|cs|fs|fsx|vb|dart|lua|r|ex|exs|erl|hrl|clj|cljs|cljc|groovy|sh|bash|zsh|fish|ps1|sql|vue|svelte|astro|html|htm|css|scss|sass|less)$/iu

/** Source files open by default; tests, docs, generated files and unknown types stay folded. */
function defaultExpandedFiles(files: DiffFile[]): Set<number> {
  const expanded = new Set<number>()
  files.forEach((file, index) => {
    const path = displayPath(file.newPath === '/dev/null' ? file.oldPath : file.newPath)
    if (!file.binary && file.hunks.length > 0
      && !TEST_PATH.test(path) && !DOC_PATH.test(path) && !GENERATED_PATH.test(path)
      && SOURCE_PATH.test(path)) {
      expanded.add(index)
    }
  })
  return expanded
}

/** The current DiffView renders plain unified text; untracked files can be
 *  drawn as a full-file addition by passing their content here. */
export function untrackedFile(path: string, content: string): DiffFile {
  const lines: DiffLine[] = []
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  if (body !== '') {
    let num = 1
    for (const line of body.split('\n')) {
      lines.push({ kind: 'add', text: line, oldNum: null, newNum: num })
      num += 1
    }
  }
  return { oldPath: '/dev/null', newPath: `b/${path}`, binary: false, hunks: [{ oldStart: 0, newStart: 1, header: '', lines }] }
}

export interface DiffViewProps {
  /** Unified diff text (`git.diff` or `git.commit-diff` payloads). */
  text: string
  /** The diff's own title (working tree / staged / commit label). */
  title?: string
  /** Optional locale helper; falls back to the en dictionary. */
  t?: (key: RightPaneLocaleKey, params?: Record<string, string | number>) => string
  /** Untracked-file content: when present, renders as a full-file addition instead of parsing. */
  untrackedPath?: string
  untrackedContent?: string
}

export function DiffView({ text, title = '', t, untrackedPath, untrackedContent }: DiffViewProps) {
  const s = (key: RightPaneLocaleKey, params?: Record<string, string | number>): string => {
    const value = t?.(key, params) ?? rightPaneEn[key] ?? key
    if (params === undefined) return value
    return value.replace(/\{([a-zA-Z0-9_]+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
  }
  const parsed = useMemo<ParsedDiff>(() => {
    if (untrackedPath !== undefined) return { files: [untrackedFile(untrackedPath, untrackedContent ?? '')] }
    return parseUnifiedDiff(text)
  }, [text, untrackedPath, untrackedContent])
  const [expanded, setExpanded] = useState(false)
  const [expandedFiles, setExpandedFiles] = useState<Set<number>>(() => defaultExpandedFiles(parsed.files))

  useEffect(() => { setExpandedFiles(defaultExpandedFiles(parsed.files)) }, [parsed])

  // Flatten into display rows so the cap can slice a single list.
  const rows = useMemo(() => {
    const out: Array<{ key: string; file: DiffFile; fileIndex: number; type: 'path' | 'hunk' | 'line'; hunk?: DiffHunk; line?: DiffLine }> = []
    parsed.files.forEach((file, fileIndex) => {
      out.push({ key: `f${fileIndex}`, file, fileIndex, type: 'path' })
      if (file.binary || !expandedFiles.has(fileIndex)) return
      file.hunks.forEach((hunk, hunkIndex) => {
        out.push({ key: `f${fileIndex}h${hunkIndex}`, file, fileIndex, type: 'hunk', hunk })
        hunk.lines.forEach((line, lineIndex) => {
          out.push({ key: `f${fileIndex}h${hunkIndex}l${lineIndex}`, file, fileIndex, type: 'line', hunk, line })
        })
      })
    })
    return out
  }, [parsed, expandedFiles])

  const hidden = rows.length - MAX_DIFF_ROWS
  const capped = hidden > 0 && !expanded
  const headLines = Math.ceil(MAX_DIFF_ROWS / 2)
  const tailLines = MAX_DIFF_ROWS - headLines
  const head = capped ? rows.slice(0, headLines) : rows
  const tail = capped ? rows.slice(rows.length - tailLines) : []

  if (rows.length === 0) {
    return <section className={css.diffView} data-dsh-plugin="web-all" data-dsh-part="diff"><div className={css.emptyState}>{s('git.diff.noDiff')}</div></section>
  }

  const renderRow = (row: (typeof rows)[number]): React.ReactNode => {
    if (row.type === 'path') {
      const tag = fileTag(row.file, s)
      const from = displayPath(row.file.oldPath)
      const to = displayPath(row.file.newPath)
      const expandable = !row.file.binary && row.file.hunks.length > 0
      const fileExpanded = expandedFiles.has(row.fileIndex)
      return (
        <button
          key={row.key}
          type="button"
          className={css.gitDiffFile}
          disabled={!expandable}
          aria-expanded={expandable ? fileExpanded : undefined}
          onClick={() => {
            setExpandedFiles(current => {
              const next = new Set(current)
              if (next.has(row.fileIndex)) next.delete(row.fileIndex)
              else next.add(row.fileIndex)
              return next
            })
          }}
        >
          {expandable && <span aria-hidden="true" className={clsx(css.gitDiffFileChevron, fileExpanded && css.gitDiffFileChevronExpanded)}>›</span>}
          <span className={css.gitDiffFilePath}>{to}</span>
          {from !== to && <span className={css.gitDiffFileOld}>← {from}</span>}
          {tag !== null && <span className={css.gitDiffFileTag}>{tag}</span>}
        </button>
      )
    }
    if (row.type === 'hunk') {
      const hunk = row.hunk!
      return (
        <div key={row.key} className={css.gitDiffHunk}>
          <span className={css.gitDiffHunkHeader}>@@ -{hunk.oldStart},{hunk.lines.filter(l => l.oldNum !== null).length} +{hunk.newStart},{hunk.lines.filter(l => l.newNum !== null).length} @@</span>
          {hunk.header !== '' && <span className={css.gitDiffHunkSection}>{hunk.header}</span>}
        </div>
      )
    }
    const line = row.line!
    const lineClass = line.kind === 'del' ? css.gitDiffDel : line.kind === 'add' ? css.gitDiffAdd : line.kind === 'meta' ? css.gitDiffMeta : css.gitDiffCtx
    return (
      <div key={row.key} className={clsx(css.gitDiffLine, lineClass)}>
        {line.kind === 'meta'
          ? <span className={css.gitDiffMetaText}>{line.text}</span>
          : (
            <>
              <span className={css.gitDiffNum}>{line.oldNum ?? ''}</span>
              <span className={css.gitDiffNum}>{line.newNum ?? ''}</span>
              <span className={css.gitDiffCode}>{line.text}</span>
            </>
          )}
      </div>
    )
  }

  const countLabel = s('git.diff.fileCount', { count: parsed.files.length })
  return (
    <section className={css.diffView} data-dsh-plugin="web-all" data-dsh-part="diff">
      <header className={css.workbenchHeader}>
        <strong>{title !== '' ? title : s('git.diff.worktree')}</strong>
        <small>{countLabel}</small>
      </header>
      <div className={css.gitDiff}>
        {head.map(renderRow)}
        {hidden > 0 && (
          <button type="button" className={css.gitDiffExpand} aria-expanded={expanded} onClick={() => { setExpanded(value => !value) }}>
            {expanded ? s('git.diff.collapse') : s('git.diff.expand', { count: hidden })}
          </button>
        )}
        {tail.map(renderRow)}
      </div>
    </section>
  )
}
