/**
 * delegation-policy-v4 自测（可复现，见 MAINTENANCE.md 规则 1）。
 *
 * 用本部署真实 cordis 的 waterfall 语义验证两件事：
 *   1. v4 的「就地修改 + next()」会把替换文本送进最终 assembly；
 *   2. 反向回归：v3 式 `next(modified)` 的替换确实会被丢弃（防止回退）。
 *
 * 运行：node plugins/delegation-policy-v4.test.mjs
 * 环境变量 DSH_CHECKOUT 可覆盖 dsh 安装路径。
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const CHECKOUT = process.env.DSH_CHECKOUT ?? '/home/pc/.local/lib/node_modules/@deepseek-ai/dsh'
const requireFromCheckout = createRequire(CHECKOUT + '/package.json')
const { Context } = requireFromCheckout('@deepseek-ai/cordis')

const v4src = await readFile(new URL('./delegation-policy-v4.js', import.meta.url), 'utf8')
const v4 = (await import('data:text/javascript,' + encodeURIComponent(v4src))).default

const ORIGINAL = 'Use the workflow tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.'

function freshAssembly() {
  return {
    sections: [
      { name: 'persona', text: 'A' },
      { name: 'tool:workflow', text: ORIGINAL },
      { name: 'other', text: 'B' },
    ],
    contexts: [],
    tools: [],
    variables: {},
  }
}

/** 按真实分发契约跑一次 waterfall：thisArg 为无 filter 载体（scopeTarget 对预设自身 tag 会放行）。 */
async function run(listener, assembly) {
  const root = new Context()
  root.plugin({
    name: 'probe-listener',
    apply(ctx) {
      ctx.on('system-prompt/assemble', listener)
    },
  })
  // 本 fork 的 ctx.plugin() 异步应用，先让 apply 落定再分发（真实运行时组装远晚于应用）。
  await new Promise((resolve) => setTimeout(resolve, 0))
  return root.waterfall({}, 'system-prompt/assemble', assembly, {}, () => Promise.resolve(assembly))
}

// ── 用例 1：v4 合作式修改生效 ────────────────────────────────────────────
{
  const assembly = freshAssembly()
  let fired = 0
  let downstreamSaw = null
  const root = new Context()
  root.plugin({
    name: 'v4',
    apply(ctx) {
      v4.apply(ctx)
      // 下游监听器：验证合作式传播（排在 v4 之后注册）
      ctx.on('system-prompt/assemble', (a, _c, next) => {
        fired++
        downstreamSaw = a.sections.find((s) => s.name === 'tool:workflow').text
        return next()
      })
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const result = await root.waterfall({}, 'system-prompt/assemble', assembly, {}, () => Promise.resolve(assembly))
  const section = result.sections.find((s) => s.name === 'tool:workflow')
  assert.notEqual(section.text, ORIGINAL, 'tool:workflow section must be replaced')
  assert.match(section.text, /delegates by default/, 'replacement text must carry the delegation posture')
  assert.equal(fired, 1, 'downstream listener must still run (cooperative, not veto)')
  assert.equal(downstreamSaw, section.text, 'downstream listener must see the mutated text')
  assert.equal(result.sections.find((s) => s.name === 'persona').text, 'A', 'other sections untouched')
  console.log('PASS 1: v4 in-place mutation + next() reaches the final assembly cooperatively')
}

// ── 用例 2：v3 式 next(modified) 确实被丢弃（回归护栏） ──────────────────
{
  const assembly = freshAssembly()
  const v3Style = (a, _c, next) => {
    const sections = a.sections.map((s) =>
      s.name === 'tool:workflow' ? { ...s, text: 'REPLACED-BY-V3-STYLE' } : s
    )
    return next({ ...a, sections })
  }
  const result = await run(v3Style, assembly)
  assert.equal(result.sections.find((s) => s.name === 'tool:workflow').text, ORIGINAL,
    'v3-style next(modified) must NOT propagate — the regression this fix prevents')
  console.log('PASS 2: v3-style next(modified) is discarded by this cordis build (bug reproduced)')
}

console.log('ALL PASS')
