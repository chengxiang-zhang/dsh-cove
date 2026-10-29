#!/usr/bin/env node
/**
 * Generate the release-notes draft for the dsh-cove GitHub Release.
 *
 * Collects conventional-commit subjects across the whole previous-tag..
 * release-tag range (including work merged in on side branches), groups them
 * into New Features / Bug Fixes / Other Changes sections, and renders the
 * notes in a split bilingual layout (v0.2.6+): the default view is Chinese
 * (summary, section headings, footer), and the English equivalents live in
 * a collapsible <details> block the reader clicks open. Each bullet keeps
 * its authored commit subject in both views. Links (#123) issue references,
 * and skips merge commits and the chore(release) bump commit itself.
 *
 * The release workflow uses this output directly as the GitHub Release body.
 * Release history stays in GitHub Releases rather than committed snapshot
 * documents. Maintainers may review the generated file in the workflow before
 * publishing or use `gh release edit <tag> --notes-file <file>` afterward.
 *
 * Usage:
 *   node scripts/release-notes.mjs <vX.Y.Z> [--repo owner/repo]
 *
 * The tag argument is the version heading (and the range end); the range
 * start is the nearest previous v* tag, or the last 30 commits when none
 * exists (first release). Needs a full-history checkout (fetch-depth: 0)
 * so the tag walk can see every tag.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')

/** The GitHub owner/repo used for issue links. */
export const DEFAULT_REPO = 'chengxiang-zhang/dsh-cove'

/**
 * The macOS installer's own notes, which the disk image ships verbatim. Putting the same
 * file on the release page means the instructions a person reads before downloading and
 * the ones inside the image cannot drift apart.
 */
export const INSTALL_NOTES_PATH = 'tools/anywhere-agent/packaging/install-notes.txt'

/** Conventional-commit prefixes grouped into the three note sections. */
const FEAT_TYPES = new Set(['feat'])
const FIX_TYPES = new Set(['fix'])
const OTHER_TYPES = new Set(['docs', 'chore', 'refactor', 'test', 'perf', 'build', 'ci', 'style', 'revert'])

/**
 * Parse one conventional-commit subject. Returns undefined when the subject
 * is a merge commit, the release bump itself, or does not match the
 * `type(scope): subject` shape (unparseable lines stay out of the notes
 * rather than polluting them).
 * @param subject - the raw subject line.
 * @returns { type, scope, subject } or undefined.
 */
export function parseSubject(subject) {
  if (subject === '' || subject.startsWith('Merge ')) return undefined
  const match = /^(feat|fix|docs|chore|refactor|test|perf|build|ci|style|revert)(?:\(([^)]*)\))?!?: (.+)$/.exec(subject)
  if (match === null) return undefined
  const type = match[1] ?? ''
  const scope = match[2] ?? ''
  const text = (match[3] ?? '').trim()
  if (text === '') return undefined
  // The bump commit itself carries no user-facing content.
  if (type === 'chore' && scope === 'release') return undefined
  return { type, scope, subject: text }
}

/** The note section a parsed commit belongs to. */
export function sectionOf(row) {
  if (FEAT_TYPES.has(row.type)) return 'feat'
  if (FIX_TYPES.has(row.type)) return 'fix'
  if (OTHER_TYPES.has(row.type)) return 'other'
  return 'other'
}

/** Turn (#123) / (#12 #34) issue references into GitHub issue links. */
export function linkIssues(text, repo) {
  const single = (input) => input.replace(/\(#(\d+)\)/g, '([#$1](https://github.com/' + repo + '/issues/$1))')
  // Multi-number groups first, then the single-number pass for the rest.
  const grouped = text.replace(/\(#(\d+)\s+#(\d+)\)/g, (_all, a, b) => {
    const linkA = '[#' + a + '](https://github.com/' + repo + '/issues/' + a + ')'
    const linkB = '[#' + b + '](https://github.com/' + repo + '/issues/' + b + ')'
    return '(' + linkA + ' ' + linkB + ')'
  })
  return single(grouped)
}

/** One bullet line: the scope badge (when present) plus the subject. */
export function bulletOf(row, repo) {
  const linked = linkIssues(row.subject, repo)
  return row.scope === '' ? '- ' + linked : '- [' + row.scope + '] ' + linked
}

/**
 * Split the installer's plain-text notes into their two halves, so each travels with the
 * matching half of these notes. Returns null when the text is not usable, in which case the
 * release simply carries no install section rather than a mangled one.
 */
export function splitInstallNotes(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const marker = /^How to install\s*$/m.exec(text)
  if (marker === null) return null
  const zh = stripPlainTitle(text.slice(0, marker.index))
  const en = stripPlainTitle(text.slice(marker.index + marker[0].length))
  if (zh === '' || en === '') return null
  return { zh, en }
}

/**
 * Drop the plain-text title (and its setext underline) of one half. The markdown heading
 * above it already says the same thing, and a second title reads as a duplicate.
 */
function stripPlainTitle(block) {
  const lines = block.split('\n')
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  if (lines.length > 0 && /^=+\s*$/.test(lines[0])) {
    lines.shift()
  } else if (lines.length > 1 && /^=+\s*$/.test(lines[1])) {
    lines.splice(0, 2)
  }
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  return lines.join('\n').replace(/\s+$/, '')
}

/**
 * Render the full markdown notes body for one release. The notes are
 * bilingual with a split layout (v0.2.6+): the default view shows the
 * Chinese summary, section headings and footer, and the English equivalents
 * live inside a collapsible <details> block the reader clicks open. Each
 * bullet keeps its authored commit subject in both views because the repository
 * may contain both Chinese and English commit subjects.
 *
 * `installNotes` is the installer's own notes file, verbatim: the released disk image is
 * ad-hoc signed, so installing it takes steps that are not guessable, and the page a person
 * downloads from is where they need to read them.
 */
export function renderNotes(version, rows, repo, installNotes = '') {
  const bySection = { feat: [], fix: [], other: [] }
  for (const row of rows) bySection[sectionOf(row)].push(row)
  const install = splitInstallNotes(installNotes)

  const enParts = [
    bySection.feat.length > 0 ? pluralize(bySection.feat.length, 'new feature', 'new features') : '',
    bySection.fix.length > 0 ? pluralize(bySection.fix.length, 'bug fix', 'bug fixes') : '',
    bySection.other.length > 0 ? pluralize(bySection.other.length, 'other change', 'other changes') : '',
  ].filter((part) => part !== '').join(', ')
  const zhParts = [
    bySection.feat.length > 0 ? bySection.feat.length + ' 项新功能' : '',
    bySection.fix.length > 0 ? bySection.fix.length + ' 项修复' : '',
    bySection.other.length > 0 ? bySection.other.length + ' 项其他改动' : '',
  ].filter((part) => part !== '').join('、')

  const zhSections = [
    ['新功能', bySection.feat],
    ['修复', bySection.fix],
    ['其他改动', bySection.other],
  ]
  const enSections = [
    ['New Features', bySection.feat],
    ['Bug Fixes', bySection.fix],
    ['Other Changes', bySection.other],
  ]

  const lines = []
  lines.push(zhParts !== '' ? '本次发布包含 ' + zhParts + '。' : '本次发布没有需要说明的功能性变更。', '')
  if (install !== null) {
    lines.push('### 安装桌面客户端 (macOS)', '', install.zh, '')
  }
  for (const [title, sectionRows] of zhSections) {
    if (sectionRows.length === 0) continue
    lines.push('### ' + title, '')
    for (const row of sectionRows) lines.push(bulletOf(row, repo))
    lines.push('')
  }

  lines.push('<details>', '<summary>English</summary>', '')
  lines.push(enParts !== '' ? 'This release contains ' + enParts + '.' : 'No user-facing changes in this release.')
  lines.push('')
  if (install !== null) {
    lines.push('### Install the desktop client (macOS)', '', install.en, '')
  }
  for (const [title, sectionRows] of enSections) {
    if (sectionRows.length === 0) continue
    lines.push('### ' + title, '')
    for (const row of sectionRows) lines.push(bulletOf(row, repo))
    lines.push('')
  }
  lines.push('---', '', 'Generated automatically by the release pipeline (scripts/release-notes.mjs).', '', '</details>', '')

  lines.push('---', '', '由发布管线自动生成（scripts/release-notes.mjs）。')
  return lines.join('\n')
}

/** "1 item" vs "2 items" — English pluralization for the summary line. */
function pluralize(count, singular, plural) {
  return count + ' ' + (count === 1 ? singular : plural)
}

/**
 * Collect and render the notes for one release tag.
 * @param cwd - the repository root to run git in.
 * @param tag - the release tag (version heading and range end).
 * @param repo - GitHub owner/repo for issue links.
 */
export function collectNotes(cwd, tag, repo = DEFAULT_REPO) {
  const previous = previousTag(cwd, tag)
  // Full-range walk, NOT --first-parent: releases routinely merge an
  // entire feature branch in one merge commit, and a first-parent walk
  // hides every commit on the merged side (the v0.1.15 notes regression).
  const args = previous === null
    ? ['log', '--format=%s', '-n', '30', tag]
    : ['log', '--format=%s', previous + '..' + tag]
  const output = execFileSync('git', args, { cwd, encoding: 'utf8' })
  const rows = []
  for (const line of output.split('\n')) {
    const row = parseSubject(line)
    if (row !== undefined) rows.push(row)
  }
  const version = tag.startsWith('v') ? tag.slice(1) : tag
  return renderNotes(version, rows, repo, readInstallNotes(cwd))
}

/**
 * The installer's notes as this checkout has them. A checkout without them (an older
 * revision, a tag cut before the image existed) simply renders no install section.
 */
function readInstallNotes(cwd) {
  try {
    return readFileSync(join(cwd, INSTALL_NOTES_PATH), 'utf8')
  } catch {
    return ''
  }
}

/** The nearest previous tag reachable from `tag`'s first parent, or null when none exists. */
function previousTag(cwd, tag) {
  // Ancestor semantics, not version sort: the second-highest version may be
  // a sibling or descendant of tag (hotfix lines, re-tags), which would make
  // the log range empty or bloated. describe walks the actual commit graph.
  try {
    const found = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', tag + '^'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return found === '' ? null : found
  } catch {
    return null
  }
}

/** Resolve the GitHub owner/repo from the origin URL (constant fallback). */
function repoOf(cwd) {
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd, encoding: 'utf8' }).trim()
    const match = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url)
    if (match !== null) return match[1] ?? DEFAULT_REPO
  } catch {
    // Fall through to the constant.
  }
  return DEFAULT_REPO
}

function main() {
  const tag = process.argv[2] ?? ''
  if (!/^v?\d+\.\d+\.\d+$/.test(tag)) {
    console.error('usage: node scripts/release-notes.mjs <vX.Y.Z> [--repo owner/repo]')
    process.exit(2)
  }
  const repoIndex = process.argv.indexOf('--repo')
  const repo = repoIndex === -1 ? repoOf(REPO_ROOT) : (process.argv[repoIndex + 1] ?? DEFAULT_REPO)
  console.log(collectNotes(REPO_ROOT, tag, repo))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
