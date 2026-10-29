#!/usr/bin/env node
/**
 * verify-docs - documentation consistency gate for dsh-web.
 *
 * Enforces the rules in docs/AGENTS.md as one executable gate:
 *   1. README triplets - the root entry documents, every package and every tool
 *      directory with a bilingual README have an English
 *      file, a Chinese file and a pairing record.
 *   2. i18n pairing - recorded git blob hashes match current content; both sides carry
 *      their language switcher; heading/code/table/list signatures mirror each other.
 *   3. Markdown links - relative link targets exist and #anchors name real headings,
 *      across the root entry documents, community health files and docs/.
 *   4. Heading levels - the first line is H1; no bare H1 sub-sections follow it.
 *   5. No scaffold placeholders in package.json descriptions.
 *
 * Usage:
 *   node scripts/verify-docs.mjs                    # check everything (CI mode)
 *   node scripts/verify-docs.mjs --list             # report state, never fails
 *   node scripts/verify-docs.mjs --write <name...>  # re-record pairing hashes after
 *                                                    confirming both sides agree
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkCurrentPackages } from './lib/current-packages.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const writeMode = args.includes('--write')
const namedPairs = args.filter((a) => !a.startsWith('--'))

const failures = []
const rows = []
function fail(msg) { failures.push(msg) }

/** Git blob hash of a working-tree file (content-addressed, no staging needed). */
function blobHash(file) {
  return execFileSync('git', ['hash-object', file], { cwd: root }).toString().trim()
}

/** Parse a pairing record into a map of file name to recorded blob hash. */
function readPairing(yamlPath) {
  const out = {}
  for (const line of readFileSync(yamlPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([\w.-]+\.md):\s*([0-9a-f]{40})\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

function writePairing(yamlPath, record, enName, zhName) {
  const header = [
    '# Bilingual-pair consistency record (docs/i18n.md): the git blob hash of each'
    , '# side as of the last confirmed-consistent state. Both languages carry equal authority;'
    , '# after editing either side, bring the other along and re-record with:'
    , '#   node scripts/verify-docs.mjs --write <label>'
  ].join('\n')
  const body = [enName + ': ' + (record[enName] || ''), zhName + ': ' + (record[zhName] || '')].join('\n')
  writeFileSync(yamlPath, header + '\n' + body + '\n')
}

/**
 * Structural signature: heading levels, fence language markers, table widths,
 * list kinds. Headings compare by level only (text is translated); fenced
 * block CONTENT is not compared — translating comments inside code samples is
 * legitimate localization, the mirror rule guards against a missing section,
 * not against translated sample text.
 */
function signature(text) {
  const sig = { headings: [], fences: [], tables: [], lists: [] }
  let inFence = null
  for (const line of text.split(/\r?\n/)) {
    const fm = line.match(/^(```+|~~~+)(\S*)\s*$/)
    if (fm) {
      if (!inFence) { inFence = fm[2] || 'plain'; sig.fences.push('open:' + inFence) }
      else { sig.fences.push('close:' + inFence); inFence = null }
      continue
    }
    if (inFence) continue
    const hm = line.match(/^(#{1,6})\s+(.*)$/)
    if (hm) { sig.headings.push(hm[1].length); continue }
    if (/^\|.*\|\s*$/.test(line)) { sig.tables.push(line.split('|').length - 2); continue }
    const lm = line.match(/^\s*(?:([-*+])\s+|(\d+)[.)]\s+)/)
    if (lm) sig.lists.push(lm[1] ? 'u' : 'o')
  }
  return sig
}

function sigEqual(a, b) {
  return JSON.stringify(a.headings) === JSON.stringify(b.headings)
    && JSON.stringify(a.fences) === JSON.stringify(b.fences)
    && JSON.stringify(a.tables) === JSON.stringify(b.tables)
    && JSON.stringify(a.lists) === JSON.stringify(b.lists)
}

/** GitHub-ish heading slug for #anchor checks. */
function slugify(heading) {
  return heading.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-')
}

function headingSlugs(file) {
  const slugs = new Set()
  if (!existsSync(file)) return slugs
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^#{1,6}\s+(.*)$/)
    if (m) slugs.add(slugify(m[1]))
  }
  return slugs
}

/** All package directories (packages/* with a package.json). */
function packageDirs() {
  return walkCurrentPackages(root).map(({ dir }) => dir)
}

/**
 * Declared bilingual pairs: the root entry documents first, then every publishable
 * package README triplet. Labels are the names accepted by --write.
 */
function pairSets(base) {
  const sets = [
    { label: 'root', dir: base, en: 'README.md', zh: 'README.zh.md', record: 'README.i18n.yaml' },
    { label: 'CONTRIBUTING', dir: base, en: 'CONTRIBUTING.md', zh: 'CONTRIBUTING.zh.md', record: 'CONTRIBUTING.i18n.yaml' },
  ]
  for (const { dir } of walkCurrentPackages(base)) {
    sets.push({ label: relative(base, dir), dir, en: 'README.md', zh: 'README.zh.md', record: 'README.i18n.yaml' })
  }
  const toolsBase = resolve(base, 'tools')
  if (existsSync(toolsBase)) {
    for (const entry of readdirSync(toolsBase).sort()) {
      const dir = resolve(toolsBase, entry)
      if (!existsSync(resolve(dir, 'README.md')) || !existsSync(resolve(dir, 'README.zh.md'))) continue
      sets.push({ label: relative(base, dir), dir, en: 'README.md', zh: 'README.zh.md', record: 'README.i18n.yaml' })
    }
  }
  return sets
}

function isExternal(url) {
  return url.startsWith('//') || url.startsWith('/') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)
}

export { signature, sigEqual, slugify, isExternal, pairSets }
if (import.meta.main) {
  /* ---------- 1 + 2 + 4. Paired documents, pairing, heading levels ---------- */
  const pairs = []
  for (const set of pairSets(root)) {
    const en = resolve(set.dir, set.en)
    const zh = resolve(set.dir, set.zh)
    const yaml = resolve(set.dir, set.record)
    if (!existsSync(en)) { fail(set.label + ': missing ' + set.en + ' (declared bilingual pair)'); continue }
    if (!existsSync(zh)) { fail(set.label + ': missing ' + set.zh); continue }
    if (!existsSync(yaml) && !writeMode) { fail(set.label + ': missing ' + set.record); continue }
    pairs.push({ ...set, enPath: en, zhPath: zh, yamlPath: yaml })
  }

  const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  for (const p of pairs) {
    const record = existsSync(p.yamlPath) ? readPairing(p.yamlPath) : {}
    const hEn = blobHash(p.enPath)
    const hZh = blobHash(p.zhPath)
    if (writeMode && (!namedPairs.length || namedPairs.some((n) => p.label.replace(/\\/g, '/').includes(n.replace(/\\/g, '/'))))) {
      writePairing(p.yamlPath, { [p.en]: hEn, [p.zh]: hZh }, p.en, p.zh)
      rows.push('re-record ' + p.label)
      continue
    }
    if (listOnly) {
      const synced = record[p.en] === hEn && record[p.zh] === hZh
      rows.push((synced ? 'ok   ' : 'sync?') + ' ' + p.label)
      continue
    }
    const enText = readFileSync(p.enPath, 'utf8')
    const zhText = readFileSync(p.zhPath, 'utf8')
    if (record[p.en] !== hEn) fail(p.label + ': ' + p.en + ' changed since the pairing record - update the other side, then run `node scripts/verify-docs.mjs --write ' + p.label + '`')
    if (record[p.zh] !== hZh) fail(p.label + ': ' + p.zh + ' changed since the pairing record - update the other side, then re-record')
    if (!new RegExp('^English \\| \\[中文\\]\\(' + escapeRe(p.zh) + '\\)', 'm').test(enText)) fail(p.label + ': ' + p.en + ' missing `English | [中文](' + p.zh + ')` switcher after H1')
    if (!new RegExp('^\\[English\\]\\(' + escapeRe(p.en) + '\\) \\| 中文', 'm').test(zhText)) fail(p.label + ': ' + p.zh + ' missing `[English](' + p.en + ') | 中文` switcher after H1')
    if (!sigEqual(signature(enText), signature(zhText))) fail(p.label + ': structural signature mismatch between ' + p.en + ' and ' + p.zh)
    const enLines = enText.split(/\r?\n/)
    const zhLines = zhText.split(/\r?\n/)
    if (!/^# /.test(enLines[0])) fail(p.label + ': ' + p.en + ' must start with an H1')
    if (!/^# /.test(zhLines[0])) fail(p.label + ': ' + p.zh + ' must start with an H1')
    for (const { lines: ls, label } of [{ lines: enLines, label: p.en }, { lines: zhLines, label: p.zh }]) {
      let inFence = false
      for (let i = 1; i < ls.length; i++) {
        if (/^```|^~~~/.test(ls[i])) { inFence = !inFence; continue }
        if (inFence) continue
        if (/^# /.test(ls[i])) { fail(p.label + ': ' + label + ' line ' + (i + 1) + ' uses H1 under a section - use H3 for install options'); break }
      }
    }
    rows.push('ok    ' + p.label)
  }

  /* ---------- 3. Markdown links ---------- */
  const linkCandidates = new Set([
    'AGENTS.md',
    'packages/AGENTS.md',
    'docs/AGENTS.md',
    'CONTRIBUTING.md',
    'CONTRIBUTING.zh.md',
    'SECURITY.md',
    'CODE_OF_CONDUCT.md',
    'SUPPORT.md',
    'GOVERNANCE.md',
    'ISSUE_TRIAGE.md',
    'PR_TRIAGE.md',
  ])
  for (const p of pairs) {
    linkCandidates.add(relative(root, p.enPath))
    linkCandidates.add(relative(root, p.zhPath))
  }
  for (const name of readdirSync(resolve(root, 'docs'))) {
    if (name.endsWith('.md')) linkCandidates.add('docs/' + name)
  }
  const docFiles = [...linkCandidates].filter((relPath) => existsSync(resolve(root, relPath)))
  for (const relPath of docFiles) {
    const file = resolve(root, relPath)
    if (!existsSync(file)) { fail(relPath + ': checked file missing'); continue }
    const rawLines = readFileSync(file, 'utf8').split(/\r?\n/)
    const lines = []
    // Strip fenced code blocks and inline code so example links inside them are
    // not treated as real references (e.g. the switcher samples in docs/i18n.md).
    let inFence = false
    for (const line of rawLines) {
      if (/^```|^~~~/.test(line)) { inFence = !inFence; lines.push(''); continue }
      lines.push(inFence ? '' : line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length)))
    }
    for (let i = 0; i < lines.length; i++) {
      const re = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g
      let m
      while ((m = re.exec(lines[i]))) {
        const raw = m[1]
        if (isExternal(raw)) continue
        const idx = raw.indexOf('#')
        const pathPart = idx >= 0 ? raw.slice(0, idx) : raw
        const frag = idx >= 0 ? raw.slice(idx + 1) : ''
        let target = file
        if (pathPart) {
          target = resolve(dirname(file), decodeURIComponent(pathPart))
          if (!existsSync(target)) { fail(relPath + ':' + (i + 1) + ': broken link `' + raw + '`'); continue }
        }
        if (frag) {
          const slugs = headingSlugs(target)
          if (!slugs.has(slugify(decodeURIComponent(frag)))) fail(relPath + ':' + (i + 1) + ': unknown anchor `#' + frag + '` in ' + relative(root, target))
        }
      }
    }
  }
  
  /* ---------- 5. No scaffold placeholders ---------- */
  for (const dir of packageDirs()) {
    const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
    if (pkg.description && /<edit me/i.test(pkg.description)) fail(relative(root, dir) + ': package.json description still contains a scaffold placeholder')
  }
  
  if (listOnly || writeMode) {
    console.log(rows.join('\n') || '(no rows)')
    process.exit(0)
  }
  if (failures.length) {
    console.error('verify-docs failed:')
    for (const f of failures) console.error('  - ' + f)
    process.exit(1)
  }
  console.log('verify-docs: all documentation gates passed')
}