import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * system-prompt strict-interpolation audit (workspace defense-in-depth).
 *
 * DSH's renderPrompt (@deepseek-ai/dsh-system-prompt, dsh-agent-loop calls it
 * on EVERY model step) interpolates `{{variable}}` references in
 * systemPrompt.section / systemPrompt.context text STRICTLY: an unknown
 * variable, a malformed group (e.g. braces inside the group), an invalid
 * name, or a valueless reference throws and fails the whole step. Raw
 * user/agent data with braces therefore must never be embedded directly in
 * section or context text — dynamic content goes through
 * `systemPrompt.variable(name, provider)`: variable values are substituted
 * verbatim and are NEVER re-scanned, so braces inside them are inert
 * (memoir regression: a memory containing `{{...}}` crashed every prompt).
 *
 * Gate rules per package:
 *   - every `{{name}}` group inside a section/context `text:` expression must
 *     reference a variable the package itself registers (systemPrompt.variable)
 *     or a DSH built-in (provider/model/cwd); after removing those references
 *     the expression must contain no remaining `{{` or `}}`;
 *   - registered variable names must match /^[a-z][a-z0-9_]*$/ (DSH
 *     VARIABLE_NAME) and must not collide with DSH built-ins (a global
 *     duplicate registration throws at load).
 *
 * Static-analysis limits (documented): a runtime-constructed group like
 * `'{' + '{' + name + '}' + '}'` is invisible here; the memoir regression
 * test (tests/integration.spec.ts brace-safe case) covers the end-to-end
 * semantics, this gate catches the common literal form.
 */

/** Variable names DSH registers globally (dsh-agent-loop lib/index.js). */
const DSH_BUILTIN_VARIABLES = new Set(['provider', 'model', 'cwd'])
/** DSH VARIABLE_NAME (dsh-system-prompt lib/index.js). */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
/** A complete simple {{name}} group. */
const REF_GROUP = /\{\{([^{}]*)\}\}/g

/** All host-source files under a package src tree. */
function collectSourceFiles() {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full)
      else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) files.push(full)
    }
  }
  for (const base of ['packages']) {
    const root = join(ROOT, base)
    if (!statSync(root, { throwIfNoEntry: false })) continue
    for (const entry of readdirSync(root)) {
      const src = join(root, entry, 'src')
      if (statSync(src, { throwIfNoEntry: false })?.isDirectory()) walk(src)
    }
  }
  return files
}

/** Scan a source string, honoring strings and nested brackets. */
function scanRanges(source, pattern) {
  const ranges = []
  let match
  while ((match = pattern.exec(source)) !== null) {
    const open = pattern.lastIndex - 1 // position of '('
    let depth = 0
    let quote = null
    for (let i = open; i < source.length; i++) {
      const ch = source[i]
      if (quote !== null) {
        if (ch === '\\') i++
        else if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch
        continue
      }
      if (ch === '(' || ch === '{' || ch === '[') depth++
      else if (ch === ')' || ch === '}' || ch === ']') {
        depth--
        if (ch === ')' && depth === 0) {
          ranges.push({ start: match.index, end: i + 1 })
          break
        }
      }
    }
  }
  return ranges
}

/** The `text:` expression inside a section/context call span, or null. */
function extractTextExpression(callSpan) {
  const open = callSpan.indexOf('(')
  if (open < 0) return null
  let depth = 0
  let quote = null
  let found = -1
  // Start after the call's opening paren: the section object's `{` then
  // lands at depth 1, where its keys (name/order/text) live.
  for (let i = open + 1; i < callSpan.length; i++) {
    const ch = callSpan[i]
    if (quote !== null) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{' || ch === '(' || ch === '[') depth++
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth--
      continue
    }
    if (depth === 1 && ch === 't' && callSpan.startsWith('text', i) && /^text\s*:/.test(callSpan.slice(i))) {
      found = callSpan.indexOf(':', i) + 1
      break
    }
  }
  if (found < 0) return null
  // Expression ends at the first top-level comma, or at the call close.
  let exprDepth = 0
  let exprQuote = null
  for (let i = found; i < callSpan.length; i++) {
    const ch = callSpan[i]
    if (exprQuote !== null) {
      if (ch === '\\') i++
      else if (ch === exprQuote) exprQuote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      exprQuote = ch
      continue
    }
    if (ch === '(' || ch === '{' || ch === '[') exprDepth++
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (exprDepth === 0) return callSpan.slice(found, i)
      exprDepth--
    } else if (ch === ',' && exprDepth === 0) {
      return callSpan.slice(found, i)
    }
  }
  return callSpan.slice(found)
}

/** Same-file plain `const NAME = 'literal'` bindings (identifier resolution). */
function collectConstLiterals(source) {
  const literals = new Map()
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"]+)['"]/g
  let match
  while ((match = re.exec(source)) !== null) literals.set(match[1], match[2])
  return literals
}

/** First argument of a variable() call: string literal or same-file const. */
function extractVariableName(callSpan, constLiterals) {
  const inner = callSpan.slice(callSpan.indexOf('(') + 1)
  const literal = /^\s*['"]([^'"]+)['"]/.exec(inner)
  if (literal?.[1] !== undefined) return literal[1]
  const identifier = /^\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(inner)
  if (identifier?.[1] !== undefined) return constLiterals.get(identifier[1])
  return undefined
}

/** One audit problem: file, line, message. */
function lineOf(source, offset) {
  return source.slice(0, offset).split('\n').length
}

function auditFile(file, source) {
  const problems = []
  const ownVariables = new Set()
  const constLiterals = collectConstLiterals(source)
  for (const range of scanRanges(source, /systemPrompt\.variable\(/g)) {
    const span = source.slice(range.start, range.end)
    const name = extractVariableName(span, constLiterals)
    if (name === undefined) {
      problems.push(`${file}:${lineOf(source, range.start)}: systemPrompt.variable() with a non-literal name — audit cannot verify it`)
      continue
    }
    if (!VARIABLE_NAME.test(name)) {
      problems.push(`${file}:${lineOf(source, range.start)}: variable name "${name}" does not match ${String(VARIABLE_NAME)} (DSH VARIABLE_NAME)`)
    }
    if (DSH_BUILTIN_VARIABLES.has(name)) {
      problems.push(`${file}:${lineOf(source, range.start)}: variable name "${name}" collides with a DSH built-in registration (dsh-agent-loop registers provider/model/cwd globally; a duplicate global registration throws at load)`)
    }
    ownVariables.add(name)
  }
  for (const range of scanRanges(source, /systemPrompt\.(section|context)\(/g)) {
    const span = source.slice(range.start, range.end)
    const expr = extractTextExpression(span)
    if (expr === null) {
      problems.push(`${file}:${lineOf(source, range.start)}: systemPrompt call without a parseable text: expression — audit cannot verify it`)
      continue
    }
    REF_GROUP.lastIndex = 0
    let cleaned = expr
    let match
    while ((match = REF_GROUP.exec(expr)) !== null) {
      const name = match[1]
      const allowed = VARIABLE_NAME.test(name) && (DSH_BUILTIN_VARIABLES.has(name) || ownVariables.has(name))
      if (!allowed) {
        problems.push(
          `${file}:${lineOf(source, range.start)}: section/context text references "{{${name}}}" without registering it — DSH interpolates {{...}} strictly and throws on unknown/malformed groups every model step. Register the value via systemPrompt.variable('${name}', provider) and reference it, or keep the text static.`,
        )
      }
      cleaned = cleaned.replace(match[0], '')
    }
    if (cleaned.includes('{{') || cleaned.includes('}}')) {
      problems.push(
        `${file}:${lineOf(source, range.start)}: section/context text contains raw "{{" or "}}" beyond registered references — DSH renderPrompt throws on malformed groups. Dynamic content with braces must ride in a systemPrompt.variable value (values are never re-scanned).`,
      )
    }
  }
  return problems
}

function auditAll() {
  const problems = []
  for (const file of collectSourceFiles()) {
    const source = readFileSync(file, 'utf8')
    problems.push(...auditFile(file, source))
  }
  return problems
}

test('every systemPrompt section/context text is static or references only registered variables', () => {
  const problems = auditAll()
  assert.deepEqual(problems, [], problems.length > 0 ? `system-prompt strict-interpolation hazards:\n${problems.join('\n')}` : undefined)
})
