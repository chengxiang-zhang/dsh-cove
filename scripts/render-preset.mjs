#!/usr/bin/env node
/**
 * Render the bundled `code-vibe` preset patch from its single source.
 *
 * `presets/code-vibe/agent.cordis.yml` is the composition the preset actually
 * runs (the deployed agent preset layer) and `presets/code-vibe/preset.yml` is
 * its roster metadata. `presets/code-vibe.patch.yml` is the loader patch that
 * inserts the same composition into a web profile, so it must be a mechanical
 * copy of the composition — not a second hand-edited original. The v4 copy of
 * this file drifted from the deployed preset twice (a garbled persona line and a
 * stale skill path), which is why the repository now derives it.
 *
 * Usage:
 *   node scripts/render-preset.mjs           # write the generated patch
 *   node scripts/render-preset.mjs --check   # fail on drift (used by CI/gates)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const PRESET_DIR = 'packages/dsh-web-all/presets/code-vibe'
export const COMPOSITION_PATH = `${PRESET_DIR}/agent.cordis.yml`
export const METADATA_PATH = `${PRESET_DIR}/preset.yml`
export const PATCH_PATH = 'packages/dsh-web-all/presets/code-vibe.patch.yml'

/** Indentation of one composition row inside the generated loader patch. */
export const ROW_INDENT = ' '.repeat(10)

const HEADER = `# Bundled \`code-vibe\` preset for DSH 0.2: the "wish programming" mode.
#
# GENERATED FILE — do not edit. The composition below is copied verbatim from
# presets/code-vibe/agent.cordis.yml and the roster metadata from
# presets/code-vibe/preset.yml; regenerate with \`node scripts/render-preset.mjs\`
# and let \`--check\` guard the pair in CI.
#
# The composition is an AGENT-PLANE list: every row belongs to the session that
# mounts this preset, and the host composition (base + web bundles) keeps the
# registries, sandbox, approvals and model route. The rendered rows and the skill
# assets behind them resolve from the installed package root through \`!!js\`
# expressions, so a profile needs no copy of either.
`

/**
 * Reads the two scalar fields the roster needs from `preset.yml`. The file is a
 * flat two-key YAML document by contract, so a full parser is not warranted;
 * anything else in it is a scope error rather than a silently ignored line.
 */
export function readPresetMetadata(text) {
  const fields = {}
  for (const line of text.split('\n')) {
    const match = /^(name|description):\s*(.*)$/u.exec(line)
    if (!match) continue
    const value = match[2].trim()
    fields[match[1]] = value.replace(/^(['"])(.*)\1$/u, '$2')
  }
  if (!fields.name) throw new Error('preset.yml: missing name')
  if (!fields.description) throw new Error('preset.yml: missing description')
  return fields
}

/** Indents every composition line so it nests under `plugins:`. */
export function indentComposition(composition) {
  return composition
    .replace(/\s+$/u, '')
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `${ROW_INDENT}${line}`))
    .join('\n')
}

/** Builds the loader patch text from the composition and the roster metadata. */
export function renderPatch({ composition, metadata }) {
  const meta = readPresetMetadata(metadata)
  return `${HEADER}- insert:
    - id: preset-code-vibe
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: code-vibe
        name: ${JSON.stringify(meta.name)}
        description: ${JSON.stringify(meta.description)}
        order: 5
        plugins:
${indentComposition(composition)}
`
}

/** Reads the sources and returns the expected patch text. */
export function expectedPatch({ root = repoRoot } = {}) {
  return renderPatch({
    composition: readFileSync(join(root, COMPOSITION_PATH), 'utf8'),
    metadata: readFileSync(join(root, METADATA_PATH), 'utf8'),
  })
}

export function main(argv = process.argv.slice(2), { root = repoRoot } = {}) {
  const check = argv.includes('--check')
  const target = join(root, PATCH_PATH)
  const expected = expectedPatch({ root })
  if (check) {
    let actual = ''
    try {
      actual = readFileSync(target, 'utf8')
    } catch {
      console.error(`render-preset: ${PATCH_PATH} is missing; run node scripts/render-preset.mjs`)
      return 1
    }
    if (actual !== expected) {
      console.error(
        `render-preset: ${PATCH_PATH} has drifted from ${COMPOSITION_PATH}; run node scripts/render-preset.mjs`,
      )
      return 1
    }
    console.log('render-preset OK')
    return 0
  }
  writeFileSync(target, expected)
  console.log(`render-preset: ${PATCH_PATH} <- ${COMPOSITION_PATH} + ${METADATA_PATH}`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
