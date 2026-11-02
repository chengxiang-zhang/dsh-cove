---
name: lane-worktree
description: Use when several independent tasks must change the same repository in parallel (multi-task / multi-agent / long-running edits) and a single working tree would collide. Each task gets its own git worktree "lane" created and registered by dsh-lane, with setup, merge preflight, serial merge and cleanup. Do NOT use for one task (normal branch), for read-only research, or when the repository's own AGENTS forbids worktrees.
---

# Lane（多任务同仓并行，worktree-per-task）

> 一个任务 = 一个 lane（独立 worktree + 分支 + 会话），互不踩；合并可预演、可回滚；滥用由机械门禁识别。
> 工具：`scripts/dsh-lane.sh`（预设 `scripts/` 内；工作区可 `cp` 到 `<workspace>/scripts/`）。

## 何时用

- 同一仓同时有 2+ 个独立任务（不同写域/不同目标），且会并行修改；
- 长任务需要与他人（或其它会话）并行，不能互相覆盖工作树/索引；
- 需要隔离实验、冲突预演、可回滚的多方案并行。

**不要用**：单任务（普通分支即可）、只读调研、该仓 AGENTS 明确禁止 lane 的情况。

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

看到这条拒绝时的正确反应：**先建 lane 再干**，不要反复重试、不要切主 checkout 的分支、不要删别人的 claim 文件。

排障：`cat <repo>/.git/dsh-claims.jsonl`（每行 `{root, sessionId, pid, ts}`）。

## 命令

```bash
export LANE_ROOT=/home/pc/lanes

scripts/dsh-lane.sh create <repo-path> <task-id>     # 建 worktree + 分支 + 登记
scripts/dsh-lane.sh setup  <task-id>                 # env/依赖/缓存/端口段
scripts/dsh-lane.sh check  <task-id>                 # setup 与该 lane 自检
scripts/dsh-lane.sh list                            # 看 open lane、TTL、stale
scripts/dsh-lane.sh merge  <task-id>                 # 预演 + flock 合并（冲突 rc=20）
scripts/dsh-lane.sh drop   <task-id> --force         # 归档会话 + 删 worktree/分支
scripts/dsh-lane.sh audit  <repo-path>               # 未登记/越界 worktree 检查
scripts/dsh-lane.sh gc                              # 超 TTL 强收（先入 .trash）
scripts/dsh-lane.sh sessions <task-id>              # 该 lane 的 DSH 会话
scripts/dsh-lane.sh archive  <task-id>              # 归档会话（不新增 GUI 项目）
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
| `merge` rc=20 | 冲突预演拦截；在 lane 内解决后重试 |
| `check` 失败 | 未 setup 或 lane 被移动；重跑 setup 或重建 |
| 未登记 worktree | `audit` 判红；要么登记要么删除 |
| lane 超 TTL | `gc` 强收（先入 `.trash` 7 天） |
| GUI 多出项目 | 用了 `register`；`drop` 时自动删登记，或手动 `workspace/delete` |

## 预算与边界

- lane 是**文件系统隔离**，不隔离端口/数据库/服务——用 `lane.env` 的 `LANE_PORT_BASE` 与各仓 schema 规则；
- 生产/发布/推上游仍按各仓红线，lane 不是绕过审批的通道；
- 身份记录/生成物冲突必须重生成 + 重跑门，禁止手解。
