#!/usr/bin/env node
/**
 * Preset reference gate: the mechanical invariants of the bundled `code-vibe`
 * preset that a reviewer should never have to re-check by hand.
 *
 * The preset is a directory of prose (a persona prompt plus skills), which is
 * exactly the kind of asset that rots silently: a renamed skill, a moved
 * reference file, a hand-edited loader patch or a stray backup copy all fail at
 * runtime inside a user's session, never in CI. This gate turns those classes
 * into a failing exit code:
 *
 *   1. `presets/code-vibe.patch.yml` is the rendered copy of
 *      `presets/code-vibe/agent.cordis.yml` (scripts/render-preset.mjs owns it).
 *   2. Every skill path referenced from the persona or a SKILL.md
 *      (`skills/<name>/...`, `../<name>/...`, "加载 `name`") resolves to a
 *      bundled skill or to a deliberately listed deployment skill.
 *   3. Every `scripts/<file>` reference resolves inside the referencing skill's
 *      own `scripts/` or the preset-root `scripts/` (the v5 layout uses both).
 *   4. No backup or cache debris ships inside the preset.
 *   5. Every skill directory declares a frontmatter `name` equal to its
 *      directory, so the catalog and the filesystem cannot disagree.
 *
 * Usage:
 *   node scripts/verify-preset-refs.mjs            # report + exit code
 *   node scripts/verify-preset-refs.mjs --list     # print the catalog
 *
 * Exit: 0 ok, 1 violations, 2 usage.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectedPatch, PATCH_PATH, PRESET_DIR, repoRoot } from './render-preset.mjs'

/**
 * Skills this preset references but does not ship: they belong to the
 * deployment's own skill store. Every entry is a deliberate exception; a new
 * name here needs a reason, not a lint rerun.
 */
export const EXTERNAL_SKILLS = new Set(['vibe-coding', 'testing', 'design-craft', 'ux-ia-and-delivery'])

/**
 * Example project paths that read like preset scripts. `large-backlog-program`
 * shows a sample task table whose write scope names a path inside the CONSUMING
 * project; the preset ships no such file and must not be asked to.
 */
export const EXAMPLE_SCRIPT_REFS = new Set(['scripts/tests/t1.py'])

export const DEBRIS_PATTERNS = [/\.bak$/u, /\.bak-/u, /\.before-/u, /__pycache__/u, /\.pyc$/u, /~$/u]

/** Loads the text the gate inspects: the composition plus every SKILL.md. */
export function readPresetTexts(root = repoRoot) {
  const presetDir = join(root, PRESET_DIR)
  const texts = []
  const composition = join(presetDir, 'agent.cordis.yml')
  if (existsSync(composition)) {
    texts.push({ path: join(PRESET_DIR, 'agent.cordis.yml'), text: readFileSync(composition, 'utf8'), skill: null })
  }
  for (const entry of readdirSync(join(presetDir, 'skills'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(presetDir, 'skills', entry.name, 'SKILL.md')
    if (!existsSync(file)) continue
    texts.push({
      path: join(PRESET_DIR, 'skills', entry.name, 'SKILL.md'),
      text: readFileSync(file, 'utf8'),
      skill: entry.name,
    })
  }
  return texts
}

/** The bundled skill catalog, read from the filesystem. */
export function readCatalog(root = repoRoot) {
  const dir = join(root, PRESET_DIR, 'skills')
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

const PATH_REF = /(?:skills\/|\.\.\/)([a-z][a-z0-9-]*)\//gu
const LOAD_REF = /(?:加载|先读|load(?:ing)?(?:\s+the)?)\s*`([a-z][a-z0-9-]*)`/giu
const SCRIPT_REF = /`(scripts\/[A-Za-z0-9_.\-/]+)`/gu

/** Skill names referenced from one document, in both path and load-phrase form. */
export function referencedSkills(text) {
  const names = new Set()
  for (const match of text.matchAll(PATH_REF)) names.add(match[1])
  for (const match of text.matchAll(LOAD_REF)) names.add(match[1])
  return names
}

/** `scripts/...` references from one document. */
export function referencedScripts(text) {
  return new Set(Array.from(text.matchAll(SCRIPT_REF), (match) => match[1].replace(/\/+$/u, '')))
}

/**
 * Resolves a `scripts/<rel>` reference. The v5 layout keeps shared helpers at the
 * preset root and skill-local helpers beside the skill, so both are legal; a
 * reference that resolves in neither is a dangling path.
 */
export function scriptResolves({ reference, skill, root = repoRoot }) {
  const relative = reference.replace(/^scripts\//u, '')
  const presetRoot = join(root, PRESET_DIR, 'scripts', relative)
  if (existsSync(presetRoot)) return true
  if (skill) {
    const skillLocal = join(root, PRESET_DIR, 'skills', skill, 'scripts', relative)
    if (existsSync(skillLocal)) return true
  }
  return false
}

/** Reads the declared `name:` from a SKILL.md frontmatter block. */
export function declaredSkillName(text) {
  const match = /^---\n([\s\S]*?)\n---/u.exec(text)
  if (!match) return null
  const name = /^name:\s*(\S+)\s*$/mu.exec(match[1])
  return name ? name[1] : null
}

/** Runs every check and returns the violation list (`{ path, message }`). */
export function verifyPreset({ root = repoRoot } = {}) {
  const violations = []
  const presetDir = join(root, PRESET_DIR)
  const catalog = readCatalog(root)
  const catalogSet = new Set(catalog)

  // 1. the loader patch is generated, not hand-edited.
  const patchPath = join(root, PATCH_PATH)
  const expected = expectedPatch({ root })
  if (!existsSync(patchPath)) {
    violations.push({ path: PATCH_PATH, message: 'missing generated loader patch' })
  } else if (readFileSync(patchPath, 'utf8') !== expected) {
    violations.push({ path: PATCH_PATH, message: 'drifted from agent.cordis.yml; run node scripts/render-preset.mjs' })
  }

  // 2-3. skill and script references resolve.
  for (const { path, text, skill } of readPresetTexts(root)) {
    for (const name of referencedSkills(text)) {
      if (!catalogSet.has(name) && !EXTERNAL_SKILLS.has(name)) {
        violations.push({ path, message: `references unknown skill \`${name}\`` })
      }
    }
    for (const reference of referencedScripts(text)) {
      if (EXAMPLE_SCRIPT_REFS.has(reference)) continue
      if (!scriptResolves({ reference, skill, root })) {
        violations.push({ path, message: `references missing script \`${reference}\`` })
      }
    }
  }

  // 4. no debris ships.
  for (const entry of walk(presetDir)) {
    if (DEBRIS_PATTERNS.some((pattern) => pattern.test(entry))) {
      violations.push({ path: join(PRESET_DIR, entry), message: 'backup or cache debris' })
    }
  }

  // 5. catalog and frontmatter agree.
  for (const name of catalog) {
    const file = join(presetDir, 'skills', name, 'SKILL.md')
    if (!existsSync(file)) {
      violations.push({ path: join(PRESET_DIR, 'skills', name), message: 'missing SKILL.md' })
      continue
    }
    const declared = declaredSkillName(readFileSync(file, 'utf8'))
    if (declared && declared !== name) {
      violations.push({
        path: join(PRESET_DIR, 'skills', name, 'SKILL.md'),
        message: `frontmatter name \`${declared}\` differs from directory \`${name}\``,
      })
    }
  }
  return { violations, catalog }
}

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.push(full.slice(base.length + 1))
  }
  return out
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/verify-preset-refs.mjs [--list]')
    return 0
  }
  const { violations, catalog } = verifyPreset()
  if (argv.includes('--list')) {
    console.log(catalog.join('\n'))
    return violations.length === 0 ? 0 : 1
  }
  if (violations.length > 0) {
    for (const violation of violations) console.error(`ERROR: ${violation.path} ${violation.message}`)
    console.error(`verify-preset-refs FAIL: ${violations.length} violation(s)`)
    return 1
  }
  console.log(`verify-preset-refs OK (${catalog.length} skills, loader patch in sync)`)
  return 0
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) process.exitCode = main()
