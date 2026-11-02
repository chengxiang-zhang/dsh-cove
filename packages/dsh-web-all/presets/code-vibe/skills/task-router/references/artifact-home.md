# 工件归址与 canonical schema

## 规范名与别名（不重命名旧文件）

| 目的 | 规范名 | 别名 | 用在哪 |
|---|---|---|---|
| 用户原话 | `quote.md` | — | T2-wish / T3-wish |
| 要做什么 | `spec.md` | `requirements.md` | T2 / T3 |
| 怎么做 | `design.md` | `design-spec.md`、`arch.md` | T2 / T3 |
| 任务与状态 | `tasks.md` | `plan.md` | T2 / T3 |
| 验收 | `acceptance.md` | `.sdd/acceptance/*` | T1–T3 |
| 运行态 | `run.md` | — | T2 / T3 |
| 运维 | `runbook.md` | — | T2-ops |
| 调研 | `findings.md` | — | TR |
| 事故 | `incident.md` | — | TX |
| 状态卡 | `STATE.md` / `tasks.md` 头 | — | 压缩恢复 |

## 归址

1. 仓库有权威 `AGENTS.md` + `docs/specs/` ⇒ 走仓库原生目录（`docs/specs/<id>/`），不另立第二套。
2. 否则 T2 走 `docs/changes/<id>/`；wish 走 `docs/wish/<id>/`；TR 走 `docs/research/<id>/`；TX 走 `docs/incidents/<id>/`。
3. T3 走账本所在目录（宪章/批次/板卡与账本同源）。
4. 一个任务只有一套工件；别名只用于兼容旧路径。

## 校验

- `check_spec.py <ws> <id> --tier T2-spec|T2-wish|T2-ops|T3`：按档检查最小工件 + acceptance 的负控/回滚。
- `verify.sh --cwd <ws> --spec <id> --kind code|ui`：code 类用 acceptance 证据；ui 类用截图+coverage。
