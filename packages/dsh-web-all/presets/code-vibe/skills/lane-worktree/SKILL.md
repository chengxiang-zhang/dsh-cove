---
name: lane-worktree
description: Use when several independent WRITE tasks must change the same repository in parallel (multi-task / multi-agent / long-running edits) and a single working tree would collide. Each task gets its own git worktree "lane" created and registered by dsh-lane, with setup, merge preflight, serial merge and cleanup. Do NOT use for one task (normal branch), for read-only analysis / data fetch / research / report work with no in-repo write, or when the repository's own AGENTS forbids worktrees.
---

# Lane（多任务同仓并行，worktree-per-task）

> 一个任务 = 一个 lane（独立 worktree + 分支 + 会话），互不踩；合并可预演、可回滚；滥用由机械门禁识别。
> 工具：`scripts/dsh-lane.sh`。**它随预设分发，不在消费仓里**：脚本在预设根的 `scripts/`，与本次加载的 `skills/lane-worktree/SKILL.md` 同属一个预设目录。调用前先解析绝对路径，不要假设 `<repo>/scripts/dsh-lane.sh` 存在：
> 1. 包内预设：`node -p "require.resolve('@dsh-cove/dsh-web-all/package.json')"` → `<pkg>/presets/code-vibe/scripts/dsh-lane.sh`；
> 2. 用户级预置目录（有的部署把预设整目录拷到这里）：`ls ~/.dsh/.agent-presets/*/scripts/dsh-lane.sh`；
> 3. 两处都没有：把脚本 `cp` 到**仓外**（`/tmp` 或 `$LANE_ROOT`）再从那里跑；不要往消费仓或只读仓里塞脚本。

## 何时用

**硬门：三条同时成立才建 lane，缺一条就不建。**

1. 同一仓同时有 **2+ 个任务**；
2. 都在**同一个仓**里（跨仓各自普通分支即可，不需要 lane）；
3. 每个任务都**真的要改这个仓**（有仓内写入）。

三条都满足的典型场景：不同写域/不同目标的并行修改；长任务与他人（或其它会话）并行、不能互相覆盖工作树/索引；隔离实验、冲突预演、可回滚的多方案并行。

**不要用**：单任务（普通分支即可）；只读调研；分析/取数/报告（无仓内写入）；任务边界还没拆清；该仓 AGENTS 明确禁止 lane 的情况。

## 不变量（违反即停）

1. **一任务一 lane**：`<LANE_ROOT>/<repo>/<task-id>`，分支 `task/<task-id>`；lane 不得建在仓库内。
2. **登记制**：只能用 `dsh-lane` 创建/登记；未登记、越界的 worktree 由门禁判红。
3. **一 lane 一 owner**：一个会话只在一个 lane 工作；**不新增 GUI 项目**——会话用 `session/create {cwd: lane}`，完成即 `archive/drop`。
4. **上限/TTL**：每仓 4、全局 8；48h 告警、96h 强收。
5. **setup 必过才开工**：`.env*`（禁 production）、依赖、per-lane 缓存、`LANE_PORT_BASE` 就绪。
6. **合并前必须预演**：`dsh-lane merge` 先 `merge-tree`；冲突即停（rc=20），由 owner 在 lane 内解决。
7. **串行合并**：`flock` 保证同一时刻一个合并者。
8. **身份/生成物冲突禁手解**：锁文件、渲染 ConfigMap、release 清单必须重生成 + 重跑门。
9. **合并后必须清理**：`dsh-lane drop`；未清理 lane 计入上限。
10. **验收回主 checkout**：lane 内红绿只作草稿。

## 占用检测（2026-11-01，门已机械生效）

不需要你自己判断"有没有别的会话在同一个 checkout"——`wish-gate` 会替你查：

- 每个会话第一次写某个工作树时，门在该仓的 `<git-common-dir>/dsh-claims.jsonl` 记一条心跳（15 分钟 TTL，30 秒续一条）；
- 同一工作树若另有活跃会话（心跳未过期），**你的写操作会被拒**，理由里直接给 lane 提示；
- 只读不占用；lane 的 root 与主 checkout 不同，不会被误判；陈旧心跳 15 分钟后自动失效，不需要手删。

看到这条拒绝时，**先判自己是不是真的要写这个仓**，再按下面三条选一条，不要反复重试、不要切主 checkout 的分支、不要删别人的 claim 文件：

1. **只读/分析**（调研、取数、实验分析、报告、量测）：**不要建 lane**——你没有仓内写入，不需要隔离工作树。把中间产物与最终产物写到仓外（`/tmp/<task>/` 或用户指定的输出目录），然后重试那一步；拒绝信息里的「建 lane 或等它结束」只针对写场景，对只读场景是错的默认。
2. **任务确实要改这个仓**：按上面的硬门建 lane（先解析脚本路径，别在消费仓里找 `scripts/dsh-lane.sh`），在 lane 里写，验收回主 checkout 跑。
3. **既不该只读、又够不上两条并行写任务**（例如只是一处小修，而当前 checkout 被别的会话占着）：等它结束（先做别的切片或直接报阻塞），不要为了抢一个工作树去造 lane。

排障：`cat <repo>/.git/dsh-claims.jsonl`（每行 `{root, sessionId, pid, ts}`）。

## 命令

```bash
export LANE_ROOT=/home/pc/lanes
# 预设内的脚本，不在消费仓：先按上文第 1–3 条解析出绝对路径再赋值
LANE_SCRIPT="${LANE_SCRIPT:?先解析预设根/scripts/dsh-lane.sh 的绝对路径}"

"$LANE_SCRIPT" create <repo-path> <task-id>          # 建 worktree + 分支 + 登记
"$LANE_SCRIPT" setup  <task-id>                      # env/依赖/缓存/端口段
"$LANE_SCRIPT" check  <task-id>                      # setup 与该 lane 自检
"$LANE_SCRIPT" list                                  # 看 open lane、TTL、stale
"$LANE_SCRIPT" merge  <task-id>                      # 预演 + flock 合并（冲突 rc=20）
"$LANE_SCRIPT" drop   <task-id> --force              # 归档会话 + 删 worktree/分支
"$LANE_SCRIPT" audit  <repo-path>                    # 未登记/越界 worktree 检查
"$LANE_SCRIPT" gc                                    # 超 TTL 强收（先入 .trash）
"$LANE_SCRIPT" sessions <task-id>                    # 该 lane 的 DSH 会话
"$LANE_SCRIPT" archive  <task-id>                    # 归档会话（不新增 GUI 项目）
```

## 在 DSH 里开会话（不新增项目）

```text
session/create {cwd: <LANE_ROOT>/<repo>/<task-id>}    # 原生 API，workspaceId=null → 不进侧栏
（可选）dsh-lane register <task-id>                    # 仅当用户明确要把它当项目
```

## 流程

1. 拆分任务，保证写域互斥；为每个任务起 `task-id`；
2. `create` → `setup` → `check`；
3. 在 lane 目录开 DSH 会话，只在该 lane 工作（可多个 lane 并行）；
4. 各自 commit；先 `merge` 一个，再对下一个 `merge` 预演；
5. 有冲突：在 lane 内 `git merge main` → 解决 → commit → 再 `merge`；
6. 合并后回主 checkout 跑该仓门，绿则 `drop`；红则保留 lane 并记录；
7. `list`/`gc` 做 TTL 巡检。

## 失败模式

| 现象 | 处理 |
|---|---|
| 消费仓里找不到 `scripts/dsh-lane.sh` | 脚本在预设根 `scripts/`，不在仓里；按「何时用」上方第 1–3 条解析绝对路径，别在仓里翻 |
| 只读任务被 checkout 占用门拒绝 | 不要建 lane：把中间产物写 `/tmp` 或仓外后重试 |
| `merge` rc=20 | 冲突预演拦截；在 lane 内解决后重试 |
| `check` 失败 | 未 setup 或 lane 被移动；重跑 setup 或重建 |
| 未登记 worktree | `audit` 判红；要么登记要么删除 |
| lane 超 TTL | `gc` 强收（先入 `.trash` 7 天） |
| GUI 多出项目 | 用了 `register`；`drop` 时自动删登记，或手动 `workspace/delete` |

## 预算与边界

- lane 是**文件系统隔离**，不隔离端口/数据库/服务——用 `lane.env` 的 `LANE_PORT_BASE` 与各仓 schema 规则；
- 生产/发布/推上游仍按各仓红线，lane 不是绕过审批的通道；
- 身份记录/生成物冲突必须重生成 + 重跑门，禁止手解。
