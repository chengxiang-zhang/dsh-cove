#!/usr/bin/env node
/**
 * Runtime dependency guardrail.
 *
 * Every bare (non-relative) import in a current package's built lib/ must
 * resolve at consumer install time:
 *
 * - node:* builtins are always available;
 * - @deepseek-ai/* is provided by the DSH runtime (see .npmrc);
 * - peerDependencies are provided by the owning runtime/application;
 * - everything else must be declared in the package's `dependencies`.
 *
 * A runtime import of a package that only sits in devDependencies crashes
 * dsh web at boot with ERR_MODULE_NOT_FOUND:
 * pnpm/npm do not install a dependency's devDependencies, so the module
 * cannot resolve. This script makes that whole bug class fail fast in CI
 * instead of at user boot.
 *
 * Built lib/ files are scanned after `pnpm build`; current packages do not
 * commit lib/, so using only tracked files would make this gate a vacuous
 * pass. A zero-package scan is rejected for the same reason.
 *
 * Usage: node scripts/runtime-deps-check.mjs
 * Tests: node --test scripts/runtime-deps-check.test.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { walkCurrentPackages } from './lib/current-packages.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Bare import specifiers in source text.
 *
 * A state-machine scan, not a regex over raw text: comments and string or
 * template literals are skipped, so prose like a JSDoc line "flips from
 * 'missing' to an mtime" cannot be misread as an import statement (the old
 * regex did exactly that and tripped the whole tree).
 *
 * @param {string} source
 * @returns {string[]} bare specifiers of `from 'x'`, `from "x"` and
 *   `import('x')` forms (relative specs and node:/@deepseek-ai/ prefixes are
 *   kept; callers filter them).
 */
export function importSpecifiers(source) {
  const specifiers = []
  const n = source.length
  let i = 0
  let state = 'code' // code | line | block | single | double | template

  /** Read the quoted specifier that starts at `start`; [text, end] or null. */
  const readSpecifier = (start) => {
    let end = start + 1
    while (end < n) {
      const ch = source[end]
      if (ch === '\\') { end += 2; continue }
      if (ch === source[start]) return [source.slice(start + 1, end), end + 1]
      if (ch === '\n') return null
      end += 1
    }
    return null
  }

  // Only words at a non-identifier boundary count as keywords; this keeps
  // `x.from` / `y.import(...)` property lookups out of the gate.
  const isKeywordAt = (word) => {
    if (!source.startsWith(word, i)) return false
    const prev = i > 0 ? source[i - 1] : ' '
    return !/[A-Za-z0-9_$.]/.test(prev)
  }

  while (i < n) {
    const ch = source[i]
    const next = i + 1 < n ? source[i + 1] : ''
    switch (state) {
      case 'code': {
        if (ch === '/' && next === '/') { state = 'line'; i += 2; break }
        if (ch === '/' && next === '*') { state = 'block'; i += 2; break }
        if (ch === '"') { state = 'double'; i += 1; break }
        if (ch === "'") { state = 'single'; i += 1; break }
        if (ch === '`') { state = 'template'; i += 1; break }
        if (ch === 'f' && isKeywordAt('from')) {
          let j = i + 4
          while (j < n && /\s/.test(source[j])) j += 1
          const quote = source[j]
          if (quote === "'" || quote === '"') {
            const got = readSpecifier(j)
            if (got !== null) { specifiers.push(got[0]); i = got[1]; break }
            i = j + 1; break
          }
        }
        if (ch === 'i' && isKeywordAt('import')) {
          let j = i + 6
          while (j < n && /\s/.test(source[j])) j += 1
          if (source[j] === '(') {
            j += 1
            while (j < n && /\s/.test(source[j])) j += 1
            const quote = source[j]
            if (quote === "'" || quote === '"') {
              const got = readSpecifier(j)
              if (got !== null) { specifiers.push(got[0]); i = got[1]; break }
              i = j + 1; break
            }
          }
        }
        i += 1
        break
      }
      case 'line':
        if (ch === '\n') state = 'code'
        i += 1
        break
      case 'block':
        if (ch === '*' && next === '/') { state = 'code'; i += 2; break }
        i += 1
        break
      case 'single':
        if (ch === '\\') { i += 2; break }
        if (ch === "'" || ch === '\n') state = 'code'
        i += 1
        break
      case 'double':
        if (ch === '\\') { i += 2; break }
        if (ch === '"' || ch === '\n') state = 'code'
        i += 1
        break
      case 'template':
        if (ch === '\\') { i += 2; break }
        if (ch === '`') state = 'code'
        i += 1
        break
    }
  }
  return specifiers
}

/**
 * Check a single package's lib sources against its declared dependencies.
 *
 * Pure function (no filesystem access) so the node:test suite can feed it
 * inline fixtures.
 *
 * @param {{ dependencies?: Record<string,string>, peerDependencies?: Record<string,string> }} pkgJson package.json
 * @param {Record<string,string>} files map of file path -> source text
 * @returns {{ file: string, specifier: string }[]} violations
 */
export function checkRuntimeImports(pkgJson, files) {
  const deps = new Set([
    ...Object.keys(pkgJson.dependencies ?? {}),
    ...Object.keys(pkgJson.peerDependencies ?? {}),
  ])
  const violations = []
  for (const [file, source] of Object.entries(files)) {
    for (const specifier of importSpecifiers(source)) {
      if (specifier === '' || /^['".]/.test(specifier)) continue
      if (specifier.startsWith('node:')) continue
      if (specifier.startsWith('@deepseek-ai/')) continue
      // Support subpath imports ('pkg/sub/path' or '@scope/pkg/sub').
      const depKey = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0]
      if (deps.has(depKey)) continue
      violations.push({ file, specifier })
    }
  }
  return violations
}

/** Recursively collect shipped JavaScript runtime files, excluding declaration-only `lib/types`. */
function builtLibFiles(dir) {
  const libDir = join(dir, 'lib')
  if (!existsSync(libDir)) return []
  const files = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'types') visit(absolute)
      } else if (entry.isFile() && /\.(?:js|cjs|mjs)$/.test(entry.name)) files.push(absolute)
    }
  }
  visit(libDir)
  return files.sort()
}

const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url

if (isCli) {
  let failed = 0
  let scanned = 0
  let expected = 0
  for (const { dir, pkgPath } of walkCurrentPackages(ROOT)) {
    const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const runtimeTargets = Object.values(pkgJson.exports ?? {}).some((entry) => {
      const target = typeof entry === 'string' ? entry : entry?.default
      return typeof target === 'string' && target.startsWith('./lib/')
    })
    if (!runtimeTargets) continue
    expected += 1
    const libFiles = builtLibFiles(dir)
    if (libFiles.length === 0) {
      console.error(`[FAIL] ${pkgJson.name}: built lib files are missing; run the repository build before this guard`)
      failed += 1
      continue
    }
    scanned += 1
    const sources = Object.fromEntries(libFiles.map((file) => [relative(ROOT, file), readFileSync(file, 'utf8')]))
    const violations = checkRuntimeImports(pkgJson, sources)
    if (violations.length === 0) {
      console.log(`[OK]   ${pkgJson.name} (${libFiles.length} lib files)`)
    } else {
      failed += 1
      console.error(`[FAIL] ${pkgJson.name}`)
      for (const v of violations) {
        console.error(`       ${v.file} imports "${v.specifier}" which is not in dependencies`)
      }
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} package(s) FAILED runtime dependency check`)
    process.exit(1)
  }
  if (scanned !== expected) {
    console.error(`\nruntime dependency check scanned ${scanned}/${expected} current packages; run it after the repository build`)
    process.exit(1)
  }
  console.log(`\nall ${scanned} scanned packages pass the runtime dependency check`)
}
