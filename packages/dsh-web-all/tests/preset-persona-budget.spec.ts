import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const compositionPath = resolve(packageRoot, 'presets/code-vibe/agent.cordis.yml')
const patchPath = resolve(packageRoot, 'presets/code-vibe.patch.yml')

const customTags = [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] as const

function personaText(): string {
  const rows = parse(readFileSync(compositionPath, 'utf8'), { customTags }) as Array<{
    id?: string
    config?: { prefix?: string }
  }>
  const persona = rows.find(row => row.id === 'persona')
  expect(persona?.config?.prefix).toBeTypeOf('string')
  return persona!.config!.prefix!
}

function compositionRows(): Array<{ id?: string; name?: string }> {
  return parse(readFileSync(compositionPath, 'utf8'), { customTags }) as Array<{ id?: string; name?: string }>
}

/**
 * The 2026-11-08 subtraction: the always-on prompt is a small core with six
 * rules and three mechanical gates. This budget test exists because the prompt
 * previously grew to 21.5k characters by appending a sentence after every bad
 * session (15 `fix(preset)` commits), and a 21.5k prompt is exactly what makes
 * the rules stop binding. Inflating it again must fail here, not in production.
 */
describe('preset persona budget', () => {
  it('keeps the always-on prompt small enough to bind', () => {
    const text = personaText()
    expect(text.length).toBeLessThanOrEqual(6000)
    expect(text.length).toBeGreaterThanOrEqual(2500)
  })

  it('keeps the six core rules and the three mechanical gates', () => {
    const text = personaText()
    for (const marker of ['原话最高', '证据分档', '三道机械门', '问答优先', '只问用户价值', '关条靠自己门']) {
      expect(text, marker).toContain(marker)
    }
    for (const gate of ['release-gate', 'release_check.py', 'turn-contract', 'check_spec --close', 'verify.sh']) {
      expect(text, gate).toContain(gate)
    }
  })

  it('does not re-inflate with the removed ceremony blocks', () => {
    const text = personaText()
    for (const removed of [
      'SIX INVARIANTS',
      'OPERATING DISCIPLINE',
      'EXECUTION DISCIPLINE',
      'APPROVAL DISCIPLINE',
      'PRODUCT FIRST, METRICS SECOND',
      'DELIVERABLE LOCK',
      'MODEL ROUTING:',
      'RELEASE GATE',
    ]) {
      expect(text, removed).not.toContain(removed)
    }
  })

  it('keeps the turn-contract row mounted in the composition and the loader patch', () => {
    const rows = compositionRows()
    expect(rows.some(row => row.id === 'turn-contract')).toBe(true)
    const patch = readFileSync(patchPath, 'utf8')
    expect(patch).toContain('- id: turn-contract')
  })

  it('keeps the launch-question detector armed with the corpus wording', async () => {
    const { isLaunchQuestion } = await import('../presets/code-vibe/plugins/turn-contract.js')
    // Verbatim rage samples from the 2026-11-06/07 fleet review that the preset
    // answered with prose; each must be recognized as a launch/close question so
    // the turn-contract steer fires instead of another debt list.
    for (const quote of [
      '你他妈到底知道上线的标准是什么？？？？你他妈的理由是生产没有更新代码？？？',
      '没有浏览器验证，你他妈为什么就敢说搞定了，你他妈为什么每次都这么垃圾；直接回答我的问题，没有任何规则限制你必须浏览器验证吗？？？',
      '为什么没有搞定，你就把目标阻塞了呢？？？？大量的工作你都不完成，你到底发生了什么垃圾呢',
      '上线前检查还有什么问题',
      '能收尾了吗',
    ]) {
      expect(isLaunchQuestion(quote), quote).toBe(true)
    }
  })
})