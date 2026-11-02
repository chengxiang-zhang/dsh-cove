/**
 * delegation-policy — code-vibe 预设的派发策略覆盖插件。
 *
 * 为什么存在：harness 的 `dsh-tool-workflow` 在 system prompt 硬编码注册了
 * section `tool:workflow`（order 115），内容是「ONLY when the user explicitly
 * asks for a workflow」——与 code-vibe 预设的 Delegate-by-default 直接冲突，
 * flash 模型实测始终遵守工具自带约束，导致 workflow 从不被主动调用。
 *
 * 机制：systemPrompt 的 section 表按「nearest scope wins」合并（
 * ScopedLayers.merge），本插件在 agent scope 层注册同名的 `tool:workflow`
 * section，即可覆盖 host 全局层那条硬编码约束。order 必须同为 115，
 * 以保证排序位置不变、只替换文本。
 *
 * inject 声明方式：Cordis 的 ctx.get() 只查当前 fiber 的 store、不沿 parent
 * 链向上找，而 systemPrompt 注册在 host 层，因此必须走属性访问（
 * ctx.systemPrompt）并声明 inject。inject 放在两处保险：本模块的静态
 * `inject` 字段，以及 agent.cordis.yml 里本行的 `inject: [systemPrompt]`
 * （行级 inject 由 loader 合并进 fiber.inject）。
 *
 * 只改 section 文本，不动工具注册（workflow 工具本身由 preset 的
 * `tool-workflow` 行提供）。本插件是纯 prompt 贡献，不发布服务，因此
 * 放在预设组成里无需 isolate realm。
 */
export default {
  name: 'delegation-policy',
  inject: ['systemPrompt'],
  apply(ctx) {
    ctx.systemPrompt.section({
      name: 'tool:workflow',
      order: 115,
      text: 'Use the workflow tool for fan-out orchestration across many subagents when the task has multiple independent, parallelizable pieces. The code-vibe preset delegates by default: do not wait for the user to name this tool. You write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. For one or two delegations, prefer plain subagent calls.',
    })
  },
}
