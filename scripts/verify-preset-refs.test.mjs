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
  ALWAYS_ON_TOOLS,
  danglingToolNames,
  declaredSkillName,
  declaredToolNames,
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

test('rule 6 fails a retired tool name and passes a registered one', () => {
  // Negative control for the rule with no preset tree in the way: the prose that
  // shipped is fed straight to the checker, so the case cannot pass by luck of
  // whatever a staged preset happens to contain.
  const retired = danglingToolNames('先派 `subagent_astra`；订阅断了换 `subagent_opus55`。', ALWAYS_ON_TOOLS)
  assert.deepEqual(
    retired.map((site) => site.name),
    ['subagent_astra', 'subagent_opus55'],
  )
  assert.deepEqual(danglingToolNames('先派 `subagent_codex`；收尾 `external_session_stop`。', ALWAYS_ON_TOOLS), [])
})

test('rule 6 reports one site per name, at its first line', () => {
  const text = 'intro\n`subagent_astra` 与 `subagent_opus55`\n再提一次 `subagent_astra`\n'
  assert.deepEqual(danglingToolNames(text, ALWAYS_ON_TOOLS), [
    { name: 'subagent_astra', line: 2 },
    { name: 'subagent_opus55', line: 2 },
  ])
})

test('rule 6 catches a retired tool name in skill prose at path:line', () => {
  const root = makePreset({ skills: { alpha: '# Alpha\n\n派 `subagent_astra` 去审。\n' } })
  try {
    assert.match(
      violationsFor(root).join('\n'),
      /skills\/alpha\/SKILL\.md:3 references unknown tool `subagent_astra`/u,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rule 6 accepts the always-on names and the composition rows', () => {
  const root = makePreset({
    persona: '- id: tool\n  toolName: subagent_fork\n',
    skills: { alpha: '# Alpha\n\n`subagent_codex`、`external_session_list`、`subagent_fork`。\n' },
  })
  try {
    assert.deepEqual(violationsFor(root), [])
    assert.deepEqual([...declaredToolNames({ root })], ['subagent_fork'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rule 6 accepts a name only a composition row declares', () => {
  // `subagent_cursor` exists in this deployment's web profile, not in the four
  // names the entity registers, so this case passes only because the row declares
  // it: the allowed set has to come from the composition, not a second list.
  const root = makePreset({
    persona: '- id: tool\n  toolName: subagent_cursor\n',
    skills: { alpha: '# Alpha\n\n`subagent_cursor` 由这一行声明。\n' },
  })
  try {
    assert.deepEqual(violationsFor(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rule 6 leaves MAINTENANCE.md and docs/ quotable and stays out of rendered patches', () => {
  const root = makePreset({ skills: { alpha: '# Alpha\n' } })
  try {
    const preset = join(root, 'packages/dsh-web-all/presets/code-vibe')
    writeFileSync(join(preset, 'MAINTENANCE.md'), '15. `subagent_astra` 已退役。\n')
    writeFileSync(join(preset, 'skills/alpha/MAINTENANCE.md'), '3. `subagent_opus55` 已退役。\n')
    mkdirSync(join(preset, 'skills/alpha/docs'), { recursive: true })
    writeFileSync(join(preset, 'skills/alpha/docs/legacy.md'), '`subagent_astra`\n')
    writeFileSync(join(root, 'packages/dsh-web-all/presets/code-vibe.patch.yml'), 'hand edit: `subagent_astra`\n')
    const found = violationsFor(root).join('\n')
    assert.doesNotMatch(found, /unknown tool/u)
    // The rendered patch is still rule 1's business: a name there is fixed in the
    // composition and re-rendered, never edited in place.
    assert.match(found, /drifted from agent\.cordis\.yml/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
