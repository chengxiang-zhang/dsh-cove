/**
 * delegation-policy — code-vibe 预设的派发策略覆盖插件。
 *
 * 为什么存在：harness 的 `dsh-tool-workflow` 在 system prompt 硬编码注册了
 * section `tool:workflow`（order 115），内容是「ONLY when the user explicitly
 * asks for a workflow」——与 code-vibe 预设的 Delegate-by-default 直接冲突，
 * flash 模型实测始终遵守工具自带约束，导致 workflow 从不被主动调用。
 *
 * 机制：不注册同名 section（`tool:workflow` 已由同 scope 层的
 * dsh-tool-workflow 行注册，NamedEntries 拒绝重复），而是监听
 * `system-prompt/assemble` waterfall，在组装结果上把 `tool:workflow`
 * section 的 text 替换为无「ONLY when」约束的版本。waterfall 的返回值是
 * 权威的（"The returned waterfall value is authoritative"），所以替换
 * 必然生效。
 *
 * 实现要点：waterfall 监听器签名 (assembly, context, next)，必须调用
 * next(modifiedAssembly) 并把修改后的 assembly 传下去，否则会 veto 整条
 * 链。只替换 name === 'tool:workflow' 的 section 文本，其余原样保留。
 *
 * 本插件是纯 prompt 贡献，不发布服务，因此放在预设组成里无需 isolate
 * realm。它在 delegation group 内，与 dsh-tool-workflow 行同 scope——但
 * waterfall 监听不是注册 section，不触碰 NamedEntries，无冲突。
 */
export default {
  name: 'delegation-policy',
  apply(ctx) {
    ctx.on('system-prompt/assemble', (assembly, context, next) => {
      const sections = assembly.sections.map((section) => {
        if (section.name !== 'tool:workflow') return section
        return {
          ...section,
          text: 'Use the workflow tool for fan-out orchestration across many subagents when the task has multiple independent, parallelizable pieces. The code-vibe preset delegates by default: do not wait for the user to name this tool. You write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.',
        }
      })
      return next({ ...assembly, sections })
    })
  },
}
