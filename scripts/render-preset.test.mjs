/**
 * The bundled preset has two sources that must stay welded: the composition the
 * preset runs (`agent.cordis.yml`) and the loader patch a web profile mounts
 * (`presets/code-vibe.patch.yml`). They drifted apart twice in the v4 era, once
 * as a garbled persona line and once as a stale skill path, and both times the
 * only symptom was a wrong prompt inside a user session.
 *
 * What is pinned:
 *
 *   - the rendered patch carries the roster metadata from `preset.yml`;
 *   - every composition row appears exactly once, in order, indented under
 *     `plugins:`;
 *   - `!!js` expressions survive verbatim, because they are the package-relative
 *     resolution that keeps a profile copy-free;
 *   - `--check` reacts to a changed composition instead of always passing.
 *
 *   node --test scripts/render-preset.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ROW_INDENT,
  expectedPatch,
  indentComposition,
  readPresetMetadata,
  renderPatch,
} from './render-preset.mjs'
import { main as renderMain } from './render-preset.mjs'

const METADATA = 'name: 许愿式编程\ndescription: 分档编码预设\n'
const COMPOSITION = `# a comment line
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: |-
      You are a test agent.

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
`

function makeRepo({ metadata = METADATA, composition = COMPOSITION } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-render-preset-'))
  mkdirSync(join(root, 'packages/dsh-web-all/presets/code-vibe'), { recursive: true })
  writeFileSync(join(root, 'packages/dsh-web-all/presets/code-vibe/preset.yml'), metadata)
  writeFileSync(join(root, 'packages/dsh-web-all/presets/code-vibe/agent.cordis.yml'), composition)
  return root
}

test('reads the two roster fields and strips wrapping quotes', () => {
  assert.deepEqual(readPresetMetadata('name: "许愿式编程"\ndescription: \'分档\'\n'), {
    name: '许愿式编程',
    description: '分档',
  })
})

test('rejects metadata that lost a required field', () => {
  assert.throws(() => readPresetMetadata('name: only\n'), /missing description/u)
  assert.throws(() => readPresetMetadata('description: only\n'), /missing name/u)
})

test('indents every composition line under plugins and leaves blank lines empty', () => {
  const indented = indentComposition('- id: a\n\n- id: b\n')
  assert.equal(indented, `${ROW_INDENT}- id: a\n\n${ROW_INDENT}- id: b`)
})

test('renders the roster metadata as quoted scalars', () => {
  const patch = renderPatch({ composition: COMPOSITION, metadata: METADATA })
  assert.match(patch, /name: "许愿式编程"/u)
  assert.match(patch, /description: "分档编码预设"/u)
  assert.match(patch, /id: preset-code-vibe/u)
  assert.match(patch, /order: 5/u)
})

test('keeps every composition row, in order, and does not duplicate the source', () => {
  const patch = renderPatch({ composition: COMPOSITION, metadata: METADATA })
  const persona = patch.indexOf(`${ROW_INDENT}- id: persona`)
  const bash = patch.indexOf(`${ROW_INDENT}- id: tool-bash`)
  assert.ok(persona > 0 && bash > persona, 'rows keep their composition order')
  assert.equal(patch.split(`${ROW_INDENT}- id: persona`).length, 2)
  assert.ok(patch.includes(`${ROW_INDENT}    prefix: |-`), 'nested config keeps its relative indent')
})

test('preserves loader expressions verbatim', () => {
  const expression = `!!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"`
  const composition = `- id: skill-filesystem\n  config:\n    customSkillDirs:\n      - ${expression}\n`
  const patch = renderPatch({ composition, metadata: METADATA })
  assert.ok(patch.includes(`${ROW_INDENT}      - ${expression}`), 'the expression survives indentation')
})

test('--check fails on a drifted patch and passes on the rendered one', () => {
  const root = makeRepo()
  try {
    const patchPath = join(root, 'packages/dsh-web-all/presets/code-vibe.patch.yml')
    // The writer is the only supported way to create it.
    assert.equal(renderMain([], { root }), 0)
    assert.equal(renderMain(['--check'], { root }), 0)
    writeFileSync(patchPath, 'stale\n')
    assert.equal(renderMain(['--check'], { root }), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the repository patch is the rendered form of the shipped composition', () => {
  const patch = expectedPatch()
  assert.ok(patch.includes(`${ROW_INDENT}- id: wish-gate`), 'the gate row ships in the preset')
  assert.ok(
    patch.includes("createRequire(baseUrl).resolve('@dsh-cove/dsh-web-all/package.json')"),
    'assets resolve from the installed package, not a profile copy',
  )
  assert.ok(!patch.includes('.agent-presets'), 'no machine preset directory leaks into the package')
})
