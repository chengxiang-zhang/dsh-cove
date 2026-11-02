/**
 * The preset reference gate exists because the preset is prose: a renamed skill
 * or a moved reference file breaks at runtime inside a user session and nowhere
 * else. These tests prove each rule both passes on a coherent preset and fails
 * on the defect it exists for, so the gate cannot become a green stamp.
 *
 *   node --test scripts/verify-preset-refs.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  declaredSkillName,
  referencedScripts,
  referencedSkills,
  scriptResolves,
  verifyPreset,
} from './verify-preset-refs.mjs'
import { main as renderMain } from './render-preset.mjs'

const METADATA = 'name: 许愿式编程\ndescription: 分档编码预设\n'

function makePreset({ persona = '- id: persona\n  name: x\n', skills = { alpha: '# Alpha\n' }, scripts = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-preset-refs-'))
  const preset = join(root, 'packages/dsh-web-all/presets/code-vibe')
  mkdirSync(preset, { recursive: true })
  writeFileSync(join(preset, 'preset.yml'), METADATA)
  writeFileSync(join(preset, 'agent.cordis.yml'), persona)
  for (const [name, body] of Object.entries(skills)) {
    mkdirSync(join(preset, 'skills', name), { recursive: true })
    writeFileSync(join(preset, 'skills', name, 'SKILL.md'), body)
  }
  for (const [name, body] of Object.entries(scripts)) {
    const target = join(preset, 'scripts', name)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, body)
  }
  renderMain([], { root })
  return root
}

function violationsFor(root) {
  return verifyPreset({ root }).violations.map((item) => `${item.path} ${item.message}`)
}

test('an internally consistent preset passes every rule', () => {
  const root = makePreset({
    persona: '- id: persona\n  config:\n    prefix: |-\n      加载 `alpha`，见 skills/alpha/SKILL.md；工具 `scripts/dsh-lane.sh`。\n',
    scripts: { 'dsh-lane.sh': '#!/bin/sh\n' },
  })
  try {
    assert.deepEqual(violationsFor(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('catches a persona naming a skill that does not exist', () => {
  const root = makePreset({ persona: '- id: persona\n  config:\n    prefix: |-\n      先加载 `ghost-skill` 再动手。\n' })
  try {
    assert.match(violationsFor(root).join('\n'), /references unknown skill `ghost-skill`/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('catches a skill path reference to a missing skill', () => {
  const root = makePreset({ skills: { alpha: '# Alpha\n\n见 `../beta/references/x.md`。\n' } })
  try {
    assert.match(violationsFor(root).join('\n'), /references unknown skill `beta`/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('accepts a script that lives beside the skill or at the preset root', () => {
  const root = makePreset({
    skills: { alpha: '# Alpha\n\n`scripts/helper.sh`\n' },
    scripts: { 'helper.sh': '#!/bin/sh\n' },
  })
  try {
    assert.deepEqual(violationsFor(root), [])
    assert.equal(scriptResolves({ reference: 'scripts/helper.sh', skill: 'alpha', root }), true)
    assert.equal(scriptResolves({ reference: 'scripts/nope.sh', skill: 'alpha', root }), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('catches a dangling script reference', () => {
  const root = makePreset({ skills: { alpha: '# Alpha\n\n`scripts/missing.sh`\n' } })
  try {
    assert.match(violationsFor(root).join('\n'), /references missing script `scripts\/missing.sh`/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('catches backup debris and a frontmatter name that disagrees with its directory', () => {
  const root = makePreset({ skills: { alpha: '---\nname: beta\n---\n\n# Alpha\n' } })
  try {
    writeFileSync(join(root, 'packages/dsh-web-all/presets/code-vibe/skills/alpha/SKILL.md.bak-20260101'), 'old\n')
    const found = violationsFor(root).join('\n')
    assert.match(found, /backup or cache debris/u)
    assert.match(found, /frontmatter name `beta` differs from directory `alpha`/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('catches a loader patch that no longer matches the composition', () => {
  const root = makePreset()
  try {
    const patch = join(root, 'packages/dsh-web-all/presets/code-vibe.patch.yml')
    writeFileSync(patch, 'hand edited\n')
    assert.match(violationsFor(root).join('\n'), /drifted from agent\.cordis\.yml/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('extracts references in both forms and ignores plain prose', () => {
  // Only the load phrase and the path form count: a bare backticked token is a
  // value far more often than a skill name, and the v4 gate that matched every
  // backticked word needed a hand-maintained exception list to stay usable.
  const text = '加载 `alpha`；见 skills/gamma/SKILL.md；`beta` 只是取值，`not a skill` 是散文。'
  assert.deepEqual([...referencedSkills(text)].sort(), ['alpha', 'gamma'])
  assert.deepEqual([...referencedScripts('run `scripts/a.sh` and `scripts/b/c.py`')].sort(), [
    'scripts/a.sh',
    'scripts/b/c.py',
  ])
})

test('reads the declared name only from a frontmatter block', () => {
  assert.equal(declaredSkillName('---\nname: alpha\ndescription: x\n---\n\n# A\n'), 'alpha')
  assert.equal(declaredSkillName('# A\nname: alpha\n'), null)
})
