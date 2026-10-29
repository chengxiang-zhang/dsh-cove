# 验证环（三钉）

> Build / Verify / Deploy 共用的**关版硬门**真源。
> Evidence Kind / Deliver Gate 细节：[`evidence-contract.md`](./evidence-contract.md)。
> 证伪刀：testing [`falsify-checklist.md`](./falsify-checklist.md)。
> 系列全角色矩阵（触发才启用）：[`version-acceptance-matrix.md`](./version-acceptance-matrix.md)。

社区对齐（克制）：**TDD** — 结束条件=测试退出码；禁改 Oracle 刷绿。
**CD** — 部署后 smoke 失败则停线，不得用 health 关版。

## 三钉（不可空转）

### 1. 关版出口唯一化

宣称 **`可交付` / `acceptance-passed` / `prod-smoke 通过`** 前，必须已跑且 exit 0：

```bash
make verify-deliver HOST=<repo> SPEC=<id>
# 或一次收口：make close-spec HOST=<repo> SPEC=<id>
```

`check_spec --closing` 即闸：矩阵 ≥1 行真 Test=Pass 且 Evidence 非占位；须 1 件磁盘产物，`override:` 也免不了（缺哪件报错会写明）。

**许愿路径关版分叉：** Agent 工程证伪 + `verify-deliver` 之后：
- 无 UI 且 P0 可机跑 → 交[证据卡](./human-acceptance-pack.md)并写 `acceptance-passed`（**禁止**请人再跑同一脚本）；
- 有 UI / 人判断 → `awaiting-human-acceptance` + 验收包；**须人明示通过/关版**后才可宣称 `acceptance-passed` / 可交付。

### 2. Build 禁改 Oracle（TDD 绿）

| 轨 | 禁止 | 允许 |
|---|---|---|
| Build / Repair | 改 Spec `tests.md`；改产品包 `06-acceptance-matrix` 等验收矩阵 Oracle | 写自动化测、改实现、记 `run.md` |
| Plan + 用户批准 | — | 修订 Oracle |

宣称「实现完成」时 `run.md` 必填：

```text
oracle-freeze: intact
红绿证据: red `<cmd>` exit=<n> · green `<cmd>` exit=0
dispatch-run-id: <id>   # eligible 片
# ineligible：executor: conductor
# 本可派但人强制自写：override: 用户要求自写 | polish · 用户本轮明示
```

有自动化 → **先红后绿**，两态命令+退出码写入上式。
Polish / trivial / 无自动化 → `红绿证据: N/A · polish|trivial|无自动化`（仍禁甩用户发现）。
缺 dispatch 证据且无 `executor: conductor` / override → `check_spec` Fail（诚实声明派生，非散文禁令）。
指挥侧 diff：不得含 `tests.md` / 验收矩阵；见 `dispatch-codex` 验收清单。

### 3. Maker ≠ grader（验收不派 Codex）

- Verify / 系列验收 / 「验到可交付」→ **Cursor/指挥侧**执行；**禁止**派 Codex 做主验收。
- Codex **可以**做机检与对抗审计:`codex exec -s read-only`（＋ `--output-schema` 要结构化结论）
  拿 diff 对**冻结的** Oracle 核对、找洞。要的是进程隔离，不是换厂商 —— 它只是不能当自己的判官。
  注意 `codex exec review` **没有** `-s`，别拿它当只读。
- Codex **不可以**:关版授权、把自己的实现判成 Pass、决定 `可交付`。这些只属指挥侧 / 人。
- 窄派单仍可用:≤15–20min、完成条件=**指定命令 stdout**；超时=失败。
- 结案前 **runner 逐条 replay 冻结的 Oracle**：`make verify-deliver HOST=… SPEC=…`。每条 P0 机检
  Oracle 都要有「基线红 + 改后绿」两半;只有绿的那半 → 不过闸。手写取证已删除——它证明的只是有人写了它。
- `人工`/`manual-only` Oracle runner 关不了：run.md 需 `人工验收：T-xxx · <谁看到了什么>`。

## Floor ≠ 关版

| 轨 | Floor（入场） | 关版 |
|---|---|---|
| Build | 相关单测/静态 exit 0（或 N/A） | 行为可观察 + 钉 2（oracle-freeze / 红绿） |
| Verify（单 Spec） | 证伪刀已跑 | 触及面勾完 + `kind=` + **钉 1** |
| Verify（系列） | 单 Spec Build Pass **不算** | 矩阵 P0 行级结果表 + **钉 1** |
| Deploy P5 | health / 进程（过程） | — |
| Deploy P6 | — | 目标环境关键路径 + 探活执行者=agent + **钉 1** |

Polish / trivial：只跑改动面自探活；仍禁甩用户发现；**不**强制全矩阵 / 全红绿对。

## 结束信号（缺一不得宣称通过）

```text
探活执行者: agent | blocked-needs-auth
产品证据: kind=<名> · <路径或命令摘要>
触及面: …（勾选或 N/A+理由）
需要用户做什么: 无需动作 | 按验收包点验 | 批准… | 真人SSO/密钥…
verify-deliver: ran (check_spec --closing exit 0)   # 可交付 / acceptance-passed / prod-smoke 通过时必有
完成标签或结论: …
```

## 反模式

| 禁止 | 正确 |
|---|---|
| `/health` 关版 | P6 产品路径 + 钉 1 |
| 请用户硬刷当探针 | Agent 先探活；挂了自己 Blocked |
| 改 `tests.md` 刷绿 | 回 Plan；钉 2 |
| 派 Codex「验到可交付」 | 指挥侧 Verify；钉 3 |
| HIT/暖路径冒充冷路径 | 按用户失败路径复现 |
| 「有条件可交付」掩盖未证 P0 | 未证 = Fail/Blocked |
| 单测绿冒充系列 Version Acceptance | 走矩阵 + P0 行级表 |
