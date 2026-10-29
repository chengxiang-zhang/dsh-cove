# Workflow 编排模板（并行构建 + 对抗验收 + 模型路由）

> 给 conductor 的复用模板：把「建切片」和「独立验收」fan-out 给子代理。
> 使用前提（2026-09-03 恢复 DSH 默认）：`workflow` 工具只在**用户显式点名 workflow** 时使用，不主动 fan-out。默认路径是 conductor 主上下文推进 + 浅层 subagent；本模板仅在用户点名 workflow 时按需套用。
> 真源：DSH `workflow` 工具 + SKILL.md「Construction channel」+「模型路由与思考深度」。

## 关键约束（先记住）

- workflow 脚本**纯协调**：没有 filesystem / bash / 网络，只能 `agent()` / `pipeline()` / `parallel()` / `phase()` / `log()`。
- 所以**闸门（journey.sh / verify.sh / replay.sh）必须由 conductor 在阶段之间用 bash 跑**，不能放进 workflow。
- 每个 `agent()` 的 prompt 必须**自包含**（子代理看不到本对话）：只传**切片上下文块**（见下），不灌整份 contract/plan。验证者用 `agent()` 天然 fresh-context——**绝不用 fork 做验证**。
- **模型路由（继承优先，同族启发）**：默认不传 `model`/`provider`。要换档就留在当前 provider、选同族兄弟（DeepSeek pro↔flash，Codex sol↔luna/terra），按任务轻重判断——不是死表。勿因目录热闹就跳到 Claude/GLM/Kimi；换族仅用户点名或任务明确需要。跨 provider 须同时传两者。不确定就继承。

## 切片结构（conductor 读 plan.md 后作为 args 传入）

```json
{
  "wish": "<id>",
  "workspace": "/abs/path",
  "slices": [
    {
      "id": "S1",
      "entry": "…",
      "oracle": "T-001, T-002",
      "paths": ["src/a.ts"],
      "boundary": "do not touch src/b/**; never edit the frozen oracle",
      "context": "本切片相关契约事实：仅摘与本切片相关的入口/表/调用点（勿整份粘贴 contract.md）",
      "deps": []
    }
  ]
}
```

## 模板脚本（复制后按 wish 填 args）

```js
const { wish, workspace, slices } = args
const contract = `${workspace}/docs/wish/${wish}/contract.md`
const plan = `${workspace}/docs/wish/${wish}/plan.md`

phase('build')
const built = await pipeline(slices, async (prev, slice) => {
  return agent(
    `You are an implementer in a wish-programming flow. The block below is the ONLY spec you may act on. ` +
    `Slice: ${slice.id} (${slice.entry}). Touched paths (hard allowlist): ${slice.paths.join(', ')}. ` +
    `Boundary: ${slice.boundary}. Relevant contract facts: ${slice.context}. ` +
    `Do not open other slices or the full contract/plan unless the block points to a section. ` +
    `Run the slice's oracle (${slice.oracle}) and append one evidence row to ${workspace}/.sdd/acceptance/${wish}.tsv ` +
    `with the v2 columns (test_id, kind, result, evidence_path, command, exit, output, ts). ` +
    `Report the LIVE exit code + evidence path + output snapshot path.`,
    { label: `build-${slice.id}`, phase: 'build' }  // omit model → inherit conductor provider/model
  )
})

phase('verify')
const verified = await pipeline(slices, async (prev, slice) => {
  return agent(
    `You are an INDEPENDENT reviewer in a FRESH context (never a fork): you did not implement ` +
    `anything and never will edit any file. Do not trust the implementer's self-report. ` +
    `Read ${contract} and the diff of ${slice.paths.join(', ')}. ` +
    `Falsify slice ${slice.id} against the frozen oracle ${slice.oracle} by RUNNING the oracle ` +
    `yourself — your evidence is the real command output, not anyone's claim. ` +
    `Reject smoke/health/build-only evidence. Return a BOUNDED verdict: at most 3 concrete, ` +
    `evidence-backed gaps — do not chase findings into over-engineering.`,
    { label: `verify-${slice.id}`, phase: 'verify', schema: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        reasons: { type: 'array', items: { type: 'string' } }
      },
      required: ['verdict']
    } }
  )
})

return { built, verified }
```

## 模型路由速查（软启发）

| 切片性质 | 建议 |
|---|---|
| 默认 / 不确定 | 省略 `model`/`provider`（继承） |
| 机械实施 / 证据收集 | 可同族快档；拿不准就继承 |
| 语义敏感 / 评审 / 裁决 | 同族强档，或直接继承 |
| 换到无关模型族 | 仅用户点名或任务明确需要该族 |

同族示例：DeepSeek pro↔flash；Codex sol↔luna/terra。强档推理、快档窄 I/O；开放设计不要丢快档。

## 并行 vs 串行

- **并行**：`deps` 为空 且 `paths` 不重叠的切片。
- **串行**：有依赖、改同一文件、或竞争同一数据库/端口/账号（见 workspace 并行规则）。
- 一切片 = 一次 `agent()`；禁止把多片塞进一个 prompt。

## 双相编排模式（2026-08-28 实测自「网关管理后台对抗验收」会话，pro+high 下 7 次 workflow 完整跑通）

对任何「多切片建设/走查/修复」任务，用固定双相结构，并把结果结构化：

```js
// Phase 1 · 并行：无共享状态的切片全部 fan-out（走查/调研/修复）
// Phase 2 · 串行：需要浏览器/同一端口/同一账号的操作一个接一个
const findingSchema = {
  type: 'object',
  properties: {
    slice: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'partial', 'fail'] },   // 三态判定
    gaps: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'string' }                                       // 证据路径/命令输出快照
  },
  required: ['slice', 'verdict']
}
```

启动前先 **probe 子代理可用性**（一个最小 `subagent` 探针，确认 spawn/工具/恢复链路正常再大规模派发）；子代理失败时 conductor **按失败原因重启该切片**，而不是回退串行。修复类任务用 fixSchema（agent + fixed 列表）让结果可机读。

## 之后（conductor，不在 workflow 里跑）

1. `replay.sh` 逐条红绿回放（基线红 → 改后绿）；
2. `verify.sh --ui` 关版闸（证据成立才过；unit/integration/health 会被 verify **live 重跑**）；
3. `journey.sh --approve --by <人>`（产品级人批注）→ `journey.sh --transition acceptance-passed`；
4. 失败的切片：conductor 按 journey.sh 路由 repairing（必须 `--reason`），repair 预算 5 轮，耗尽转 `stuck`。
