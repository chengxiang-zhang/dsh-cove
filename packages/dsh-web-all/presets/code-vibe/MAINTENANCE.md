# 维护约定

本预设（`code-vibe` / 许愿式编程）的维护铁律。**诚实定性：这套东西是纪律约定 + 便利脚本 + 组织模式，不是运行时强制。** 脚本是自跑的确定性清单；真正的强制来自 DSH 的审批栈 / 沙箱 / plan mode。

1. **改规则必须带探针**：新增或修改任何「规则 / 脚本」，变更应引用一条可复现的自测（脚本自测用例），证明旧规则确实漏了，并指出被替换 / 删除的对象。
2. **prose 净行优先为负**：加规则前先想能不能删 / 合并 / 换样例。`SKILL.md` 是 always-on 窗口，别让它膨胀。
3. **脚本先自检**：任何脚本改动先 `bash -n` 再落地，并保留正反用例。
4. **概念单一真源**：状态词、证据种类等**概念**只在一处定义；`SKILL.md` 尽量做指针，正文在 `references/` 或脚本。小 shell helper（如 `find_root`）允许复制，不为此上纲上线。
5. **不吸收清单**（从 sdd-vibe-coding BORROW 继承）：
   - 角色剧场 / 多 persona（BMAD）；
   - 跨项目愿望注册中心（愿望是项目内的、持续的）；
   - 照抄 check_spec 的 **1850 行散文正则 linter**（本预设只有一个轻量结构检查 `check_spec.py`，且它是清单，不是强制）。
6. **改 `scripts/` 后必须重跑 `gate-lock.sh`**：`verify.sh` / `journey.sh` 用 `MANIFEST.sha256` 校验门禁脚本完整性，忘锁会被自己的门禁拒绝（这是特性，不是 bug）。
7. **delegation-policy 的 waterfall 契约**：`tool:workflow` section 的覆盖依赖 `system-prompt/assemble` 的就地修改（mutate assembly → `return next()`）。本部署 cordis 的 waterfall `next` 是零参闭包，`next(modified)` 的参数会被丢弃（v1/v2 同 scope 同名 section 冲突、v3 踩了这个坑，都不生效）。改该机制前必须跑 `plugins/delegation-policy-v4.test.mjs`，两条用例全过才能落地。
8. **生效路径（2026-08-28 实测）**：改 `agent.cordis.yml`（persona 等内联文本）→ 新会话经 standing stamp 校验即生效，无需重启；改 `plugins/*.js`（模块代码/常量）→ 模块被进程级 ESM 缓存，**必须重启 DSH** 才生效。派发行为由 persona 顶部的「FIRST ACTION」规则驱动（实测：仅靠中部触发条目，glm-5.3/flash 模型会自行串行执行；规则置顶并明令禁止串行后，同一任务零提示即扇出 3 个并行 subagent）。
9. **模型是委派行为的最大变量（2026-08-28 对照实测）**：同预设同提示词，kaon/deepseek-v4-pro-0813 + high → 第一动作即 3 并行 subagent，子代理 3/3 完成；glm-5.3/flash → 约 2/3 触发，且子代理易因弱模型端点 500 夭折。委派链路的目标模型是 pro+high（settings `agent-default-model` 已默认如此）；弱模型下提示词只能提高概率不能保证。多切片走查/验收的可复制模式（双相编排 + findingSchema 三态判定 + probe 子代理 + 失败重启不回退）已固化进 `skills/wish-programming/references/workflow-template.md`，源自「网关管理后台对抗验收」会话实测。

10. **PROGRAM MODE（大清单 + Agent Team 长跑）2026-10-29 落盘**：来源是一次 194 轮 / 3389 步 / 8 teammate / 73 卡的长跑会话
    （`session-4576e754`，10-27→10-29），前半程反复出现「Lead 自己写实现 / 空跑报表轮 / 包全 done 但清单未关 / 压缩后行为回退」，
    后半程靠「批次闭环 + 条目自己的门 + 独立 verifier + 磁盘宪章」跑通（账本 34→3）。
    - 新增 `skills/large-backlog-program/`（清单体检→归并→方案组→独立任务→spec 包）与
      `skills/agent-team-project-loop/`（角色边界/派工/回执/验收/账本/收尾信号/抗压缩/窗口/出口）各含 `references/` 模板。
    - `agent.cordis.yml` persona 新增一段 PROGRAM MODE（触发词 + 八条不变量，~1.8K 字符；**第 11 条审计后升级为九条**）。**为什么放 persona**：
      压缩会丢对话、不丢 persona；这些不变量必须在压缩后仍在窗口里，skill 只在触发时加载。
    - 探针（规则 #1）：机械 `python3 skills/agent-team-project-loop/scripts/selfcheck.py`；
      行为 `skills/agent-team-project-loop/probes/behavior-probe.md`（A/B/C 查 persona，D/E/F 查 skill）。
    - 回滚：`cp agent.cordis.yml.bak-program-mode-20261029 agent.cordis.yml` 并删除两个新 skill 目录。
    - 已知限制：① 这是纪律约定，不是运行时强制（同本文件开头）；② 行为探针依赖团队工具可用（web profile 的
      agent-team bundle）；无 team 工具时按 skill §0 降级为 subagent，判据不变；③ 模板按"单仓 + 多模块"抽象，
      多仓/多服务项目要改 `INDEX/INTERFACES` 的归属口径。

11. **PROGRAM MODE 全量审计与重写（2026-10-29 晚）**：用户追问"是否真的读完了"，随后给了充足预算做全量审计。
    - 审计规模：助手正文 555K 字 + 团队消息 730K 字逐字全读；8 teammate 会话 + 24 workflow 子会话；
      38 个批次行按 `callId` 重配对核验；6 份压缩摘要 50 条断言核对；账本 158 个提交全轨迹复原。
      报告：`AUDIT-20261029.md`；原件 `/tmp/audit/reports/`。
    - 关键结论：方法主体成立；但**关条证据只有 24/38（63%）可复现**，"假完成"入口在被质疑后 2 分 38 秒
      改关条口径；"非终态 0"是 64 条状态改写；最终 3 条开放是真实的（0 条标签移动）。
    - 改动：persona 八→九条不变量（全部改成可判定式）；`agent-team-project-loop/SKILL.md` 增 §5.3 E1–E8
      机器判据、窗口六要素、KILL 五条件、半信号规则、摘要作废、恢复三连；`anti-patterns.md` 全量重写（30+ 条）；
      `batch-ledger.md` 证据拆三格 + 契约判据；`project-charter.md` 增他证三件套/锚点扫描/判定可复现/写令牌；
      `large-backlog-program` 增价值门/KILL 五条件/锚点图/覆盖检查；探针加 G/H；selfcheck 覆盖九不变量。
    - 探针（规则 #1）：`python3 skills/agent-team-project-loop/scripts/selfcheck.py`（全绿）；
      行为探针 A–H（`probes/behavior-probe.md`）。
    - 回滚：`cp agent.cordis.yml.bak-program-mode-20261029 agent.cordis.yml` 并删除两个新 skill 目录
      （回滚会退回"八不变量 + 未审计版 references"）。
    - 已知限制：① 审计是"会话内可复现性"判定，不等于"事实未发生"（部分读数可能在 run.md/回执/日志里）；
      ② 仍有 8 项未验证（见 `AUDIT-20261029.md` §5）；③ 规则仍是纪律约定，不是运行时强制。

12. **v5 终稿收敛（2026-10-29）**：把分档、上下文/并发、压缩韧性、社区调研、提示词政策收敛为唯一终稿
    `FINAL-PLAN-v5-20261029.md`（命名统一 T/A/R/E/EC/MC；预算三档 H/T/D；20 Gap/10 P0；I0–I7；发布门 8 条）。
    输入稿（RESTRUCTURE/ARCHITECTURE/DESIGN×4）已加"输入稿"横幅，冲突以终稿为准；LANDSCAPE/PROMPT-SOURCES
    为参考稿；UPGRADE-PLAN* 待归档。**当前预设行为未改**；按终稿 I0–I7 实施，I0 不动行为。
    验证：终稿自检 + 实施后 `selfcheck.py`/eval/探针；回滚见各迭代条目。

13. **v5 实施（I0–I6 完成）**：按 `FINAL-PLAN-v5` 落地：新增 `task-router`/`fix-loop`/`change-spec`/`research-brief`/`incident-runbook`；
    persona 3.8K→1.96K（6 条不变量，PROGRAM 9 条迁入 agent-team，产品门迁入 wish）；agent-team 9.5K→6.59K、large-backlog 5.3K→4.45K；
    `check_spec --tier` + 别名、`verify.sh --kind code`；证据目录/工件归址统一；文档归档到 `docs/design`、`docs/archive`。
    验证：selfcheck 全绿、YAML 解析、脚本冒烟、gate-lock 重锁；**行为评测（分档 12 题/回归 6/探针）需新会话执行**。
    报告：`docs/IMPLEMENTATION-REPORT-v5.md`；回滚见该报告 §5。

14. **v5 补全（P0/P1 收口，2026-10-29 晚）**：persona 补到 **2,541 tokens**（目标内）；agent-team 降到 **5,182 tokens**；
    探针补到 30 条（A–H + P1–P6 + P-C + P-F）；新增机械脚本 `check_lead_scope/check_batch_ledger/check_plan_card/ctx_budget`；
    `evals/run-smoke.sh` + fixtures **11/11 通过**；`check_spec` 默认/五 tier 冒烟全过；`docs/portable/AGENTS.md` +
    安装 README；`evals/promptfoo/` 数据集骨架。**唯一硬缺口**：30 探针 + 20 题的行为评测需新会话执行（当前会话 persona 为旧版，测了也不算）。

15. **v5 真实 UI 验证 + 挂载修复（2026-10-29 20:45）**：用第二个 `dsh web`（3099）挂载 v5，Playwright 实跑 14 条分档题 + 3 条 P-F。
    结果：分档 14/14；上下文/并发行 14/14；工件门 9/14；P-F2/P-F3 通过、P-F1 部分。
    **关键修复**：发现线上只加载 bundled `code-vibe`，自定义预设未挂载；已在 `~/.dsh/profiles/web/cordis.patch.yml`
    加 `preset-code-vibe` override（实测可加载 v5；**重启后生效**；回滚=删该块并重启）。
    另：从自定义 `agent.cordis.yml` 移除不可用 `tool-session-query`（会致 agent-preset/invalid）。
    未跑：6 回归、压缩探针、A–H/P1–P6/P-C 其余。详见 `docs/VALIDATION-v5-20261029.md`。

## wish-gate 已移除（2026-11-02）

- 它曾是什么：`plugins/wish-gate.js`，一个随预设分发的机械门插件——按关键词/任务档拦写入、要求先加载 spec、拦未经用户要求的 `git commit`/`git push`，并在 `<git-common-dir>` 里给会话记工作树占用心跳。
- 为什么移除（owner 决定，2026-11-02，逐条一行）：
  - 只读命令被误拒（`git -C <repo> log`、纯计算 heredoc 等本不落盘的调用被当成写）；
  - 同一机制的镜像面会锁死真正要写这个仓的会话（只读会话替自己占了工作树）；
  - 状态文件 `dsh-claims.jsonl` 落在用户仓库的 `.git` 里，等于往别人的仓里写私有状态；
  - 合同套件在 HEAD 上就是红的，门自身没有可信的绿。
- 留下了什么：`skills/lane-worktree/SKILL.md` 与 `scripts/dsh-lane.sh` 仍是纪律 + 便利工具（一任务一 lane、登记、合并预演、串行合并、清理、`audit`）；跨会话占用避让回到「会话自己看工作树」，**没有机械占用门**。预设的强制力仍只来自 DSH 的审批栈 / 沙箱 / plan mode。
- 历史与本轮判断依据：`docs/GATE-FIX-REPORT-20261101.md`、`docs/GATE-FIX-REPORT-20261102.md`。

12. **外部强 agent 派发能力（2026-11-03 落盘）**：把「复杂设计/排障派给更强的 agent 拿独立结论」变成预设能力，而不是某台机器的口头约定。
    - 新增 `skills/design-dispatch/`：何时派（L3 / 要冻结 / 本地连续同质结论 / 排障假设收敛）、两条通道的路由（`subagent_astra` 订阅默认；订阅断了直接换 `subagent_opus55`）、Design Packet 六段、并行红队与三分法、结果处理（外部结论只是输入，事实要本机复跑）。
    - persona 加了一行路由（`design-orchestrator` 之后）；`design-orchestrator` §4 加一句「reviewer 可以是外部 agent」。**为什么放 persona**：压缩会丢对话、不丢 persona；派发是执行动作，必须在第一次派工前就可见。
    - 装机（规则 #3，脚本自带正反用例）：`sh skills/design-dispatch/scripts/install.sh`。四步幂等——npm 装两个 ACP adapter、复制 `acp-probe.mjs` 到 `~/tools/acp-agents`、往 profile `cordis.patch.yml` 追加带标记的两 provider+两工具行、跑 preflight。`--check` 只体检，`--uninstall` 只摘 profile 块。实测（**两通道时期的读数，2026-11-03 断 kaon 前**）：fresh 装出 6 行/YAML 合法；第二遍只重生成 1 个块（provider 行不翻倍）；uninstall 后行数归 0、重装恢复。断 kaon 后块变成 4 行，条数与幂等语义不变，但上面这组数字是当时真实的，不改写成 4 行冒充新读数。
    - 探针（规则 #1）：`sh skills/design-dispatch/scripts/preflight.sh`。`PREFLIGHT_ALL_OK` 才算通道可用；退出码 1=通道不可用，2=机器前置缺失。**已知限制**：它只验通道可用性，不验产质量；每次真跑一次极小调用（约 6k tokens），不要放进循环。本机 2026-11-03 实测三通道：codex-subscription 12696ms / codex-kaon 11153ms / claude-opus55 11627ms，全 `PREFLIGHT_OK`。
    - 生效路径（规则 #8）：新增 skill 目录由 `skill-filesystem` 目录扫描发现，persona 改动走 standing stamp → **新会话生效，无需重启**；adapter 与 DSH profile 的三个工具行属于机器前置，不在本仓。
    - 已知边界：外部 agent 是 one-shot（不能续接/中途 steer）；只回最终文本（过程不可审计）；claude 经网关的 `total_cost_usd` 不可信，只认 `usage`；`gpt-6-astra-pro` 订阅不支持、`kaon/gpt-6-astra` 无路由、claude 仅 `kaon-rp/claude-opus-5-5` 前缀可用。
    - 回滚：删除 `skills/design-dispatch/`，persona 与 `design-orchestrator` 的两句话回退即可，然后 `node scripts/render-preset.mjs`。

13. **Codex 不接 kaon（2026-11-03 用户裁决）**：`kaon/gpt-6-astra` 在 kaon 侧 `404 no available route`；`kaon/gpt-6-astra-pro` 有路由但走 OpenRouter 公共额度，实测 3/3 `rate_limit_exceeded`；`kaon/gpt-5.5` 可用但换了模型等于换了能力。结论：**订阅不可用就换 claude，不做同引擎换计费**。已删除 profile 的两行（`subagent-acp-astra-kaon` / `tool-subagent-astra-kaon`）、仓内 `codex-acp-kaon.sh`、以及 `install.sh` / `preflight.sh` 里的对应分支。回滚：`/tmp/cordis.patch.yml.bak-drop-kaon-20261103` + `git checkout` 该轮改动。
