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
    - **2026-11-06 更正**：ACP 双通道已整体退役（`8416d2e`），本条的装机脚本、ACP 探针与三通道 preflight 全部作废并删除；路由改由 `subagent_codex` / `subagent_claude_code` 承担，见 #17。

13. **Codex 不接 kaon（2026-11-03 用户裁决）**：`kaon/gpt-6-astra` 在 kaon 侧 `404 no available route`；`kaon/gpt-6-astra-pro` 有路由但走 OpenRouter 公共额度，实测 3/3 `rate_limit_exceeded`；`kaon/gpt-5.5` 可用但换了模型等于换了能力。结论：**订阅不可用就换 claude，不做同引擎换计费**。已删除 profile 的两行（`subagent-acp-astra-kaon` / `tool-subagent-astra-kaon`）、仓内 `codex-acp-kaon.sh`、以及 `install.sh` / `preflight.sh` 里的对应分支。回滚：`/tmp/cordis.patch.yml.bak-drop-kaon-20261103` + `git checkout` 该轮改动。 **2026-11-06 状态**：该裁决针对的 ACP 双通道已不存在，条目仅作历史；当前 codex 侧只有 profile 配置的 codex CLI 路由。

16. **派发写域 + 断言机械化（2026-11-04，用户裁决"改预设而不是每次手工"）**：来源是一次真实派发——`subagent_opus55` 返回约 4000 字设计正文，产物 30 处 `file:line` 里只有 8 处被本机跑过，而**抄写与评分压在同一个人身上**：Lead 把正文吸进上下文重写一遍，再人肉逐条复现。用户选了"让它直接写盘"，并指出这属于预设缺陷，不该每次靠人自觉。
    - 规则改动（`skills/design-dispatch/SKILL.md` §5）：**删掉**「派发默认只读 → `git status` 必须为空」（它把"不许写"当成安全，实际代价是手抄）；**删掉**「对"被接受的结论"抽样复核」（机械全量判定取代抽样）；**删掉**「质量门只信确定性信号」独立条目（内容并入新条目）。**新增**三条：写域由 packet 声明（`只读` 或 `写域=<路径>`，对的是"域"不是"空"）、产物自带 `claims.jsonl`、写的人不当评分人。§3 第 6 段同步要求断言另存一份，否则仍要手抄。**净行实测 106→109（+3）**：没做到规则 #2 的"净负"，因为三条新规则都是硬约束；schema 已外移到脚本头注释，避免它在 SKILL.md 与脚本里各写一份。
    - 新件：`skills/design-dispatch/scripts/verify-claims.mjs`。两种断言（`file-line` / `command`），只有 `verified|unverified` 两态（沿用预设既有的 已证实/未证实，不新增第三态）；`--report` 直接产出"未证实"清单贴回产物。**折行处理**：范围匹配先归一化（去注释装饰、合行、压空白）——首版没做，探针当场把我自己一条正确的折行引用判成未通过，属工具缺陷不是断言错误。
    - 探针（规则 #1 / #3）：`node skills/design-dispatch/scripts/verify-claims.mjs --selftest` → **14/14**（7 条正例 + 7 条负例，含"折行短语必须绑定""相距行不得绑定""denylist 拦 `rm` / `git push`"）。真实断言复跑：把 2026-11-04 那批 9 条断言写成 claims 后 **8/9 verified**，唯一未过的是那条我人工也复现不出的 `140k` 字符上限——工具判定与人工判定逐条一致。
    - 已知边界：`command` 只能跑 argv（`shell: false`），denylist 防误删误推，**不是沙箱**（`node -e`、解释器、名单外的二进制仍能干真事）；断言来自我们选择给了写权限的 agent，这条只防手滑不防恶意。折行归一化会让跨行短语匹配，但不制造跨远行的假通过（合行保序）。
    - 备份：用 git（`git show HEAD:...`），**不落 `.bak-*`**——`scripts/verify-preset-refs.mjs` 的 `DEBRIS_PATTERNS` 明确禁止备份垃圾进预设。
    - 回滚：`git checkout 8c78ba5 -- packages/dsh-web-all/presets/code-vibe/skills/design-dispatch/SKILL.md`，删 `scripts/verify-claims.mjs`，删本条。persona 与 `agent.cordis.yml` **未改**，所以不需要 `render-preset.mjs`。

17. **派发路由对齐已退役的 ACP 工具（2026-11-06）**：`8416d2e` 把委派工具搬到实体行并退役 `subagent_astra` / `subagent_opus55`，但只改了 composition 的工具行；persona 与 5 个技能的派发指令仍指向旧名。`pnpm preset:check` 一直是绿的，因为它只校验技能目录与脚本路径，**不认工具名**。
    - 改了什么：persona 两条常驻行（`PATHS` 的 executor 路由、`MODEL ROUTING`）；`design-dispatch`（§1 改成两个委派工具 + 两个控制工具、§2 去掉装机只留 preflight、§5 回执字段、§6 已知限制）、`task-router`、`incident-runbook`、`design-orchestrator`、`wish-programming` 与 `agent-operation` 的模型路由块、`workflow-template` 的同族示例。
    - 删了什么：`skills/design-dispatch/scripts/install.sh`（装机已无意义——工具由实体行注册）与 `scripts/acp-probe.mjs`（ACP 探针）。
    - 重写了什么：`scripts/preflight.sh` 改成零 token 探测——CLI 在不在（读 profile 的 `claudeBin` / `codexBin`，退回 PATH）、profile 有没有 `externalSession`、域挂载状态（200 已挂载 / 403 不在围栏 / 404 没挂载）。本机实测 `PREFLIGHT_OK codex 0.166.0-alpha.6` / `PREFLIGHT_OK claude 2.1.318` / `PREFLIGHT_OK mount 200` → `PREFLIGHT_ALL_OK`。
    - 为什么这次不会再烂：`scripts/verify-preset-refs.mjs` 加了第 6 条规则——预设文本里任何 `subagent_*` / `external_session_*` 名字必须落在「composition 的 `toolName:` ∪ 实体注册的工具」里，否则 `pnpm preset:check` 判红。`MAINTENANCE.md` 与 `docs/` 被规则显式排除（历史记录允许出现旧名）。
    - 口径：`model` 只有一个来源——profile 的 `externalSession.tools.<provider>.models`；`gpt-6-astra-pro` 在当前账号 400；claude 的 opus 类要求 Claude Code ≥ 2.1.280（2.1.318 实测可用）。换族 = 换工具，两个委派工具都没有 `provider` 参数。
    - 回滚：`git revert` 本次提交（旧 `install.sh` / `acp-probe.mjs` 一并回来），然后 `node scripts/render-preset.mjs`。

18. **派发不再阻塞回合，进度与部分结果可见（2026-11-06）**：一次派发实测 189–1914 秒，而工具是同步阻塞的：整个回合被占住，父回合一旦取消就回 `result: ''`（store 里留下两轮 `aborted` 零产出）。用户反馈两条一起：不监控运行、直接阻塞会话。
    - 适配器边跑边读：claude 500ms、codex 250ms 轮询 `readFrom(cursor)`，只解析完整行，尾行留到下一次；累积 `assistant`（claude）与 `item.completed/agent_message`（codex）文本，按帧计数并上报 `{frames, toolCards, tool_calls, chars, lastFrameAt, tail}`（tail 取末尾 4000 字符）。
    - 工具面：`subagent_claude_code` / `subagent_codex` 加 `wait_ms`（默认 15000、上限 600000、`0` 立即返回）。窗口内结算回原结果；否则回 `status: running` 加 `progress`。新增 `external_session_wait(session_id, timeout_ms?)`（默认 60000）；`external_session_list` 每行带 `running`；下拉每行显示状态（运行中 12s · 静默 3s / 失败 / 已关闭 / 部分结果），弹层开着就按 2s（有轮次在跑）或 5s（空闲）刷新。
    - 部分结果：取消 / 停滞 / 超时的轮次返回已产出文本并标 `partial: true`，`result` 永不为空串；两条期限是静默 600000 毫秒判 `turn-stalled`、墙钟 2400000 毫秒判 `turn-timeout`，都保留已产出文本。
    - 父回合取消只作用于还在 `wait_ms` 窗口里的那一段；回 `running` 之后子进程继续跑，直到 `external_session_stop` 或期限。
    - 读数：`engine-progress.test.ts` 8 条、`codex.test.ts` 11 条、全包 137 files / 1935 passed；`claude` 适配器由 Lead 直接改，`codex` 适配器由独立实现者改并以变异测试证明（关掉 partial → 3 红、关掉轮询 → 5 超时、lossy 追加而非重建 → chars 9≠6）。
    - 回滚：`git revert` 本次提交，然后 `node scripts/render-preset.mjs`。

19. **外援按会话绑定，不再全局混列（2026-11-06）**：用户反馈「所有对话都显示外援的内容」，实际是把宿主级的一个池子挂到了每个会话的下拉上。
    - 根因：记录里没有任何字段说明是谁派出去的，下拉又是在 `document.body` 上做增强（与当前会话无关），于是每个会话都看到同一份全局清单。
    - 改法：`ExternalTurnRequest.originSessionId` 由工具从 `exec.agent.session.header.id` 取；引擎在**首轮创建**时写进记录，续轮不改（换会话续跑，归属仍在发起者）。视图与列表带出该字段。
    - 客户端：下拉只列 `originSessionId === 当前会话` 的条目，无则整组不渲染；右侧面板默认同样只看本会话，勾选「全部会话」才显示其它会话与来源未知的历史记录，并标「其它会话」/「来源未知」。
    - 兼容：老记录没有该字段 → 不进任何会话的下拉，只在「全部会话」里出现。store 版本不变（纯追加字段）。
    - 模型侧同口径：`external_session_list` 默认只列本会话（`originSessionId` 比对），`scope: "all"` 才是全host 视图；不这么做，别条会话的外援会进本会话上下文。
    - 读数：`engine-progress` 3 条绑定用例、`model-selection` 2 条（来源透传 + 列表范围）、客户端 69 条；external-session 两套 193 passed。
    - 回滚：`git revert` 本次提交；client 与 host 两侧要一起回，否则下拉会因缺字段而恒空。

20. **生效方式按热更现实写（2026-11-06）**：旧口径是"改 `cordis.patch.yml` 或包行一律要重启"，与实测不符，且会让每个 conductor 都去打断用户。
    - 事实（见 `docs/hmr.md`）：发行版 base 层把 HMR 的 `root` 设为 `[]`，本部署没有"改文件自动生效"；宿主与客户端代码在**构建后由一次 profile 重组**热替换（实体行化之后重组返回 `applied`）；保存 patch **不触发**重组（实测：非法 YAML 保存后 10 秒日志 0 新增行）；预设散文按会话组合生效。
    - 改动：`design-dispatch` §2 的生效段改为指向 `docs/hmr.md` 并按"重组 / 刷新页面 / 重启"三档写清；仓库根 `AGENTS.md` 的运行中服务条款同步，并明确"不允许把需要刷新页面写成需要重启"。
    - 回滚：`git revert` 本条对应的提交；该条只改文档与技能措辞，不涉及运行时代码。

21. **外援会话退出右栏启动菜单（2026-11-06）**：用户指出右栏那排工具里不该有「外援会话」。
    - 机制：右栏启动菜单是官方 `SidebarRightTabRegistry.guide()` 把各页签注册时 `guide` 数组展开、按 `order` 排序的结果。登记 `guide` 才进菜单；不登记仍可用 `openTab(kind)` 打开。
    - 改动：`client/external-session/index.ts` 不再登记 `guide`（同时删掉随之无用的图标 import 与 `TAB_ORDER`），页签本身与下拉条目保留。入口改为会话头部下拉的外援条目——与"外援跟会话绑定"同一口径。
    - 读数：`mount.test.tsx` 增加一条断言（注册了 id/kind、且 `guide` 为空）；客户端 69 条全绿。
    - 回滚：恢复 `guide` 数组即可重新出现在菜单里，无数据或契约变化。

22. **进度改为增量流（2026-11-06）**：旧协议下 claude 一条回答只落一帧（`assistant`），单条超长消息期间只有心跳，看起来与卡死无异。
    - 取样：`claude -p --output-format stream-json --verbose --include-partial-messages --permission-mode auto` 跑 120 词回答，8 帧 → **74 帧**（其中 60 个 `content_block_delta`/`text_delta`，每个正文块一小段）。
    - 改动：claude 适配器 argv 加 `--include-partial-messages`；累计器把 `text_delta` 拼进 `text` 并据此推进 `chars`/`tail`/`idle_ms`；后到的 `assistant` 帧整段重复同一文本，用 `sawDeltas` 标记避免重复计数；没有增量的旧流仍按旧路径解析。
    - 读数：新增 `providers/claude.test.ts` 4 条（增量累计、不重复、旧流兼容、半行跨读）；真机 gated 用例复跑绿，取消那条从 26.6 s 降到 **7.5 s**（增量一进来就满足取消条件）。
    - 回滚：去掉 argv 里的 `--include-partial-messages` 即可回到一帧一消息，累计器对无增量流本就兼容。

23. **发布轨补齐（2026-11-08，用户报告「上线前检查答成生产代码没更新」）**：来源是一次真实会话——用户问「具备全量上线的条件了吗」，回答是「生产还在跑旧代码、检查器 PASS=51/FAIL=15/SKIP=2、没有生产登录验收与回滚演练、告警没在生产验证」。当时预设的结构缺陷：流程止于用户 judge，`journey.sh --assert deploy` 硬编码永远失败，`evidence-contract` 指向一个从未随预设移植的 `deploy` skill，E2E 只有「多视口截图」没有真实点击；于是「能不能上线」只能被答成一段流程欠账。
    - 新增 `skills/release-gate/`（SKILL + `references/release-plan.md`）：P0–P6、一次授权协议、真 blocker vs 自己欠账、E2E 三件套、判据。
    - 新增机械门 `skills/wish-programming/scripts/release_check.py`：九项 PASS/FAIL，`--run` 才执行声明的只读命令，产出 `.sdd/release/<id>/status.tsv` 与逐项 log；`gate-lock.sh` 的 FILES 与 `journey.sh` 的完整性校验都纳入它。
    - `journey.sh` 增 `--authorize-deploy --by --quote`（授权原话落 `.sdd/acceptance/<id>.deploy-authorized`）；`--assert deploy` 从「永远 FAIL」改为「发布方案 + 授权同时在盘」；`--assert claim-deliver` 在 `TARGET=production` 时必须 `release_check.py --run` 全 PASS。
    - `wish-programming` 五→六阶段：新增阶段 6 发布，阶段 4 增 E2E 三件套；`check_spec.py --phase close` 对 UI 愿望（design-spec 有页面树）要求 `e2e/{steps.md,run.log,≥1 截图}`。
    - persona 加一段 RELEASE GATE（净 +941 字节 / 约 +235 tokens）：目标计划期声明、production 同会话走完 P0–P6、「能不能上线」贴表、自己的欠账不算 blocker。
    - 路由：`task-router` §10 增「能上线了吗 / 上线前检查」→ `release-gate`；`change-spec` 的 T2-ops 明示生产发布不走它；`quality-review` 证据表增 browser-job 落点；`evidence-contract` 与 `human-acceptance-pack` 的悬空 `deploy` 引用改为 `release-gate`。
    - 追加发现（同一轮）：`preset-self-review` 与 `release-gate` 的 SKILL.md frontmatter 里写了 `: `，YAML 解析失败，加载器只打一条 warn 就把整个 skill 丢掉——`pnpm preset:check` 一直是绿的，因为它只正则读 `name:`。修好两处描述，并给 `verify-preset-refs` 加第 7 条：`name`/`description` 的纯量值出现 `: ` 或 ` #` 即判红；真机 mount 复核 36 个 skill 全部进目录（`[SKILLS]` 含 `release-gate`）。
    - 探针（规则 #1）：`pnpm -C packages/dsh-web-all exec vitest run tests/preset-release-gate.spec.ts tests/preset-release-flow.spec.ts`——`release_check` 正例 9/9，四个负例（缺授权 / `/health` 冒充冒烟 / 缺 E2E / 无 `--run`）逐条红；flow 用例证明「没有发布方案不能授权」「有方案+授权才 `--assert deploy` ok」「UI 愿望缺 e2e 时 `check_spec --close` exit 1、补齐后 exit 0」「release commit 未 push 时 `change-set` FAIL」；`verify.sh --kind ui` 的手工双向探针：e2e 齐备 exit 0，抽掉 `e2e/` exit 1 并点名 `steps.md`。
    - 已知边界：这是纪律 + 机械门，不是运行时强制；`release_check.py` 只认 `.sdd/release/<id>.env` 的十个键，拼错键按缺失处理；`--run` 执行 agent 自己声明的只读命令，脚本不做沙箱；授权「本回合」语义靠 `.deploy-authorized` 的 ts 与执行记录，脚本不能证明同一回合。
    - 回滚：`git revert` 本次提交，然后 `node scripts/render-preset.mjs` 与 `bash skills/wish-programming/scripts/gate-lock.sh`。

24. **上线/收尾回合的运行时契约（2026-11-08，用户质问「agent 根本不遵守」）**：先摆结论——11-02 删除 `wish-gate` 后本预设只剩散文，`git log` 里 15 个 `fix(preset)` 提交都在加规则，遵守率没有因此变好。这次不加散文，改回运行时：新增 `plugins/turn-contract.js`，只用三个事件——`agent/inbox/claimed`（只认 `source.kind === 'user'` 的原话）、`tools/result`（记录本轮是否执行过 `release_check.py`）、`agent/turn-stopping`（未执行就 `agent.steer` 一次，文案给出确切命令）。
    - **不复活 wish-gate 被删的四条机制**：不拦任何工具调用、不做工作树占用、不写用户仓 `.git`、不弹人闸问题。错过只会多一条 steer，不会卡住会话。
    - 挂载：`agent.cordis.yml` 一行 `@dsh-cove/dsh-web-all/presets/code-vibe/plugins/turn-contract.js`；真机 temp profile 实测组成 29 行、`turn-contract` fiberState=2、无失败行。
    - 判据：`packages/dsh-web-all/tests/turn-contract.spec.ts` 8 条（上线问句矩阵、否定句不触发、只认 release_check 执行、一轮最多一次、已跑不 trigger、普通回合不触发、子代理不触发、`TURN_CONTRACT_STEER=0` 关断）。测试命令 `pnpm -C packages/dsh-web-all exec vitest run tests/turn-contract.spec.ts`。
    - 生效边界：`plugins/*.js` 走进程 ESM 缓存，**加行或改模块都必须重启 DSH（profile 重组）**；persona/skill 散文仍是新会话生效。真机行为（steer 是否真的发出）本轮未验证——验收动作：重启后新开许愿会话问「能上线了吗」，看是否被 steer 去跑 `release_check.py`。
    - 已知限制：单向软门，不是阻断；文案里的 `<preset>` / `<workspace>` 是模板，模型要按 skill 解析；它不替代 `release_check.py` 的九项机械判据，只负责把回合拉回门前。
    - 回滚：删 `plugins/turn-contract.js` 与组成里那一行，`node scripts/render-preset.mjs`，重启；或 `git revert` 本次提交后重启。

24. **预设没有运行：装配缺最后一步，「全绿」被当成证据（2026-11-08）**：用户追问「agent 预设为什么没办法避免这个事情」——一次「会话绑定」修补交付了放宽范围的兜底 + 锁住它的镜像测试 + 「69 条全绿」的报告，线上仍是全局清单。
    - 根因（装配）：本机 `~/.dsh/profiles/**` 里 0 处挂载本预设（无 `code-vibe` / `许愿式编程` 字样），会话日志实测 `agent-preset/selected → cordis`（DSH 出厂预设），所以 quality-review / evidence-contract / wish-programming / release-gate 一条都没进上下文。仓里只有 composition + roster + loader patch 三件套，**「挂进 profile」这一步没有文档、没有脚本、也没有检查**；`preset:check` 只校验仓内一致性，不校验是否挂载。
    - 根因（口径）：即便挂上，旧口径也挡不住这次——Evidence Kind 是 spec-driven（Job Pass 的 `api-diff` / `network-har` / `browser-job`），而这次是没有 spec 的顺手修；`falsify-checklist` 管「证伪某个 Then」，不管「新写的判据必须在旧行为下红」。照实现写的镜像测试 + 全绿在旧口径里完全合法。
    - 改动：`skills/quality-review/SKILL.md` 加载即执行硬门增第 7 条（行为修复出「旧行为红 / 恢复后绿」一对读数，只贴绿不构成证据，为界面不空而放宽范围判 Fail）；`references/evidence-contract.md` 增 `fails-on-old-behavior` Kind 与「行为修复的硬门」段，并声明与「绿 = 证据」互斥。
    - 已知边界：`skills/wish-programming/scripts/check_spec.py` 没有 evidence kind 机检（全包 grep 0 命中），这条目前是散文，执行点是评审与仓 `AGENTS.md` 的同款规则（预设无关，`cordis` 会话也读得到）。
    - 待办：把预设挂进 `~/.dsh/profiles/web` 需要一次 profile 重组（不重启、可回滚）；挂上后新开会话才带许愿编程规则。
    - 回滚：`git revert` 本条提交；规则条文本身不涉及运行时行为，回滚只影响下一次会话组合。

25. **减法：常驻 persona 21,576 → 4,107 字符（2026-11-08，用户选 A「先做减法再发版」）**：来源是机队会话读数——7 天窗口 27 条顶层 code-vibe 会话 / 480 轮 / 8664 次工具调用 / **56 条辱骂** / 16 次 ask；最差会话 223 轮、单回合 5.6 小时；2 天窗口 13 条辱骂，且 `0.9.0` 一台机器都没装到修复。结论：问题不是缺规则，是常驻文本已经长到规则不绑定，且同一套六阶段被套在工单/评审/运维/问答上。
    - 删掉（约 17.5k 字符）：SIX INVARIANTS 长文、OPERATING DISCIPLINE (a)–(f)、EXECUTION DISCIPLINE (a)–(g)、APPROVAL DISCIPLINE、PRODUCT FIRST/METRICS SECOND、DELIVERABLE LOCK/DETAIL/BATCH、MODEL ROUTING 长表、BUILD ROUTING、PM RULES 长文、RELEASE GATE 长文；`task-router` 的分档细节、`agent-operation` 的模型路由/委托判据、`design-dispatch` 的冷通道探针各自保留在 skill 里。
    - 留下六条 + 三道机械门：原话最高 / 证据分档 / 三道机械门（release_check、e2e 三件套、turn-contract）/ 问答优先 / 只问用户价值（可逆默认、不阻塞目标）/ 关条靠自己门（四数与磁盘状态）。
    - 默认路径改为 T2-wish 短路径；六阶段只给 T3-wish（`wish-programming` 顶部）。`task-router` D4=2 改为「只为用户价值取舍问一次（≤2 个问题）」；`wish-programming` 的「先问再画」改为只在无法自查询问。
    - 判据（新增 `packages/dsh-web-all/tests/preset-persona-budget.spec.ts`）：persona ≤6000 字符、六条与三门 marker 必须存在、八段被删长文不许回来、turn-contract 行必须挂载、corpus 里的真实辱骂问句必须被 `isLaunchQuestion` 命中；连同 `turn-contract.spec.ts` 13 条全绿。
    - 回归口径：27 条会话是基线（rage/asks/long-loop 已在 `.harvest/wish-preset-review/2026-11-07T01-30-57-610Z/REPORT.md` 与 2 天增量报告里）；发版 rollout 后按同一 7 天窗口复跑 `pnpm wish-review` 对比——判据 rage/session→0、asks≤1、maxTurn≤1800s、无「宣称完成后收回」。
    - 回滚：`git revert` 本提交恢复 21.5k persona（不推荐：它就是这次减法的对象）；预算测试会拦住无意回涨。

26. **验证仪器分档：端到端闸门不做内循环（2026-11-12，自迭代定时任务 `preset-self-review`）**：同一 7 天窗口里两条顶层 `code-vibe` 会话的两个反方向失败，指向同一个缺失概念——"这条改动该跑哪一层验证、能跑几次"。
    - `session-e691986c`（pc-tower，33 轮 / 单轮 8129s / 917 次工具 / 8 条辱骂）：每修一处就跑 20–40 分钟冷重建当验证尺子；用户连问「你他妈为什么不能分不修复验证，为什么每次都要用冷启来验证」「我不理解验证为什么要用冷启」，并在模型自称"已改"后又问两次「你他妈又开始冷启了吗」；模型自认「你把最终验收和单点验证混了」。
    - `session-79505767`（pc-tower，同一 workspace，11-06→11-08）：反方向——改动后没跑项目自己的冷重建就宣称完成，用户质问「我的问题是你修改完之后，有没有做冷启动重建」。
    - **文本形状（可复现探针，不依赖会话数）**：现有预设只有单边约束。`grep -rn "端到端" skills/*/SKILL.md` ⇒ 4 处：`wish-programming:74`（E2E 三件套，缺了不得宣称验收完成）、`quality-review:45`、`release-gate:50` 都是"必须做"方向，第 4 处 `measurement-evidence:61` 是延迟指标（无关）；`grep -rniE "只跑一次|最多一次|不做内循环|不要每次都|重复重建|重复冷启" skills/` ⇒ **0 命中**。唯一一句"为一行改动重启服务/重建环境"在 `fix-loop`，被限定 T1，而这两条会话是 T2-ops/T3 的 deliver，落在禁令之外。
    - 改动：`skills/task-router/SKILL.md` 新增 §6.1（3 条：先跑便宜档 / 端到端只做最终闸门且同一处修复最多一次 / 收尾仍必须回到端到端）。放 task-router 而非 persona，因为每次 DELIVERY 必载、不进常驻窗口，符合 #2 与 #25 的减法方向；第三条是刻意保留的双边约束，防止 #25 之后的规则被读成"可以跳过端到端"（那正是 `79505767` 的失败）。
    - 定性：**方向性改动，未行为验证**。散文无运行时强制，可复核判据只有上面的文本探针（旧文本确实只朝一个方向）；真机验证要等发版 + 机队 rollout 后，在同一 7 天窗口复跑 `pnpm wish-review`，看 rage/session 与 maxTurn 是否下降、以及"跳过端到端"是否复发。
    - 回滚：`git revert` 本提交，然后 `node scripts/render-preset.mjs`。

27. **清理类任务的对象域：宽泛的「全部清理」不解锁环境资源（2026-11-13，自迭代定时任务 `preset-self-review`）**：同一 7 天窗口的两条顶层 `code-vibe` 会话，在同一个 workspace 上把同一件事犯了两遍——用户要清理的是仓内失效产物，模型顺手把构建缓存与镜像卷一起 prune 掉。
    - `session-e691986c`（pc-tower，11-11，33 轮 / 8 条辱骂）用户当场划禁区：「全部都可以清理呀，全部都是测试数据；**但是禁止把编译、镜像等都给清理了** S3的数据可以全部清理」。
    - `session-33a287c4`（pc-tower，11-12，31 轮 / 15 条辱骂）隔天复发：用户问「还有哪些垃圾可以清理，给我清单」，模型在出清单的同时执行了 `docker builder prune`（构建缓存 232.8G→199.4G）与 `docker volume prune`（悬空卷 202→37），并清理了本地缓存与分支，回收约 42G；随后用户点名边界：「**我让你清理的是垃圾失效的代码、配置和文档，你为什么动构建换成和镜像呢？？？**」。
    - **文本探针（旧文本确实漏了，可复现）**：`git show HEAD:packages/dsh-web-all/presets/code-vibe/skills/task-router/SKILL.md | grep -cniE "prune|构建缓存|环境资源|对象域"` ⇒ **0**；对 `skills/*/SKILL.md` 逐个搜 `prune|docker (builder|volume)|构建缓存` ⇒ **0 命中**；同时 `agent.cordis.yml:50` 把 `cleanup` 列进「可逆技术决策你自己拍」的括号清单——这正是被读成「清理范围由我定」的那句许可。框架本身不缺口径（§1 D3=2 已要求真人授权），缺的是**范围扩张时重算 D3**：仓内文件清理是 D3=1，扩到环境资源就是 D3=2，同一轮里被静默跨过去了。
    - 改动（一处缺陷、两个落点收口）：`skills/task-router/SKILL.md` §7 反例表新增一行——清理对象域只认用户点名的那一类（失效代码/配置/文档），扩到环境资源（构建缓存 / 镜像 / 卷 / 集群·S3 数据）⇒ D3 变 2，重新分档 + 单独一次授权，一句宽泛的「全部清理」不解锁禁区；`agent.cordis.yml` 的许可句把 `cleanup` 收窄为 `cleanup of what the user names`（+25 字符，persona 4107→4132，远低于 6000 预算），防止再被读成「清理范围自定」。
    - 定性：**方向性改动，未行为验证**。散文无运行时强制；可复核判据只有上面的文本探针与 persona 预算测试。真机验证要等发版 + 机队 rollout 后，在同一 7 天窗口复跑 `pnpm wish-review`，看「清理越界」类 rage 与 `asks` 是否下降。
    - 回滚：`git revert` 本提交，然后 `node scripts/render-preset.mjs`。
