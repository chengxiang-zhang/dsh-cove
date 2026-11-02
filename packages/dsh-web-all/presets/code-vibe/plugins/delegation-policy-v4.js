/**
 * delegation-policy v4 — code-vibe 预设的派发策略覆盖插件（就地修改版）。
 *
 * 为什么存在：harness 的 `dsh-tool-workflow` 在 system prompt 硬编码注册了
 * section `tool:workflow`（order 115），内容是「ONLY when the user explicitly
 * asks for a workflow」——与 code-vibe 预设的 Delegate-by-default 直接冲突，
 * 实测模型始终遵守这条更晚出现的硬约束，导致 workflow 从不被主动调用。
 *
 * 机制：监听 `system-prompt/assemble` waterfall，把组装结果里
 * `tool:workflow` section 的 text 就地替换为无「ONLY when」约束的版本。
 *
 * 契约（v3 → v4 的关键修正）：
 * 本部署的 Cordis waterfall 是 compose 语义——`EventsService.waterfall` 的
 * `next` 是零参闭包，永远用原始 args 数组继续链条
 * （`(cbs.shift() ?? inner)(...args)`），监听器传给 `next(modified)` 的
 * 参数会被直接丢弃。v3 调用 `next({ ...assembly, sections })`，替换从未
 * 生效：链条继续用的是原始 assembly，fallback 返回原始对象，模型看到的
 * 一直是 harness 原文。事件契约（dsh-system-prompt README）要求
 * 「cooperatively mutate or replace」——可替换值只有两条路：
 *   1. 就地修改共享的 assembly 对象，然后 `return next()`（合作式，本文件采用）；
 *   2. veto：不调用 next()，直接 return 修改后的 assembly（会跳过后续监听器）。
 * 本部署没有其他 assemble 监听器，但就地修改 + next() 最稳：即使未来有
 * 别的监听器，本插件的替换仍随共享对象传播。
 *
 * 本插件是纯 prompt 贡献，不发布服务，因此放在预设组成里无需 isolate
 * realm。它在 delegation group 内，与 dsh-tool-workflow 行同 scope——但
 * waterfall 监听不是注册 section，不触碰 NamedEntries，无冲突。
 *
 * 自测：plugins/delegation-policy-v4.test.mjs（用真实 cordis 复现 waterfall
 * 语义，同时断言 v3 式 `next(modified)` 的替换确实会被丢弃，防止回退）。
 */
const REPLACEMENT = 'Use the workflow tool for fan-out orchestration across many subagents when the task has multiple independent, parallelizable pieces. The code-vibe preset delegates by default: decompose each task first — \u22652 independent sub-tasks of any kind (implementation slices, research or inspection topics, verification, docs drafts) \u2192 parallel subagent calls in one message; \u22653 slices or a multi-phase plan \u2192 workflow fan-out. Do not wait for the user to name the tool, and never execute independent sub-tasks serially. You write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls. Every task brief must carry a user-perspective line (目标用户是谁 + 做完后用户能看到/感受到什么变化; if the slice has no user-visible surface, say so explicitly). Product/architecture reviews must cite the role rubrics in skills/wish-programming/references/roles/ (pm-reviewer / design-reviewer / arch-reviewer); authors never self-grade.'

export default {
  name: 'delegation-policy',
  apply(ctx) {
    ctx.on('system-prompt/assemble', (assembly, _context, next) => {
      for (const section of assembly.sections) {
        if (section.name === 'tool:workflow') section.text = REPLACEMENT
      }
      return next()
    })
  },
}
