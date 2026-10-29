---
name: quality-review
description: 验收/UX 走查/体验审计专项：先证伪再 Pass、人类验收包、多视口截图证据、版本验收矩阵；Use when 验收、UX 走查、体验审计、walkthrough、wish-programming 阶段 4/5 或用户说「走查/验收/看看效果」时加载；只读不改实现。
---

# Quality Review（验收/UX 走查专项）

> 从 SDD 体系（sdd-vibe-coding，MIT）移植的 Verify 专项：证伪优先、证据契约、人类验收包。
> 与 wish-programming 阶段 4（机械验收）和阶段 5（用户 judge）联动；**maker ≠ grader**——验收用独立视角，不信任实现者自述。

## 加载即执行的硬门

1. **证伪先于结案**：适用项标 Pass 前，先执行「怎么证伪」步骤（`references/falsify-checklist.md` 默认证伪刀：翻页/无界滚动/表单校验等至少一刀，失败 = Fail，不许 smoke 覆盖）。
2. **先读再走查**（UX 走查变体）：`references/ux-standards.md` → `references/ux-walkthrough.md`；未完成必读名单 → 禁止宣称已按 design-standards 走查。
3. **floor ≠ 关版**：最低证据线不是验收通过线；`references/verification-loop.md` 的「结束信号」是关版前必须复核的清单。
4. **同会话 Build→Verify 禁止誊抄**：Build 期间的 window-smoke/health 结果不得原样当 Verify Pass；须重跑证伪或等价命令并记新证据。
5. **人类验收包**：有 UI 的愿望交付前产出 `references/human-acceptance-pack.md` 格式的验收包；多角色/多表面系列 → `references/version-acceptance-matrix.md`，禁止单 Spec Pass 冒充系列 Pass。
6. **证据契约**：Evidence Kind 以 `references/evidence-contract.md` 为准；Browser 证据 → `references/browser-verify.md`（真实通道、多视口截图落 `.sdd/acceptance/<id>/shots/`）。

## 册导航（references/ 内）

| 场景 | 读什么 |
|---|---|
| 证伪优先清单（先读） | `falsify-checklist.md` |
| 证据分层与表述 | `evidence-contract.md` |
| 结束信号 / Floor≠关版 | `verification-loop.md` |
| UX 走查（变体） | `ux-standards.md` → `ux-walkthrough.md` |
| 人类验收包模板 | `human-acceptance-pack.md` |
| 版本验收矩阵（系列） | `version-acceptance-matrix.md` |
| 浏览器真实通道 | `browser-verify.md` |
| 有界验收 / 回归 / 验证报告 | `bounded-verify.md` · `product-regression.md` · `validation-report.md` |
| 设计标准对照（走查引用） | `../frontend-design/references/design-standards/`（LOAD-MAP / product-judgment / change-control / ai-tells） |

## 证据落点对接（Evidence Kind ↔ coverage.tsv / shots/）

> 本 skill 的 evidence-contract 定义证据**类型**；wish-programming 阶段 4 的 coverage.tsv 定义证据**落点**。两者是同一证据的两个维度，对照本表填写。

| evidence-contract Evidence Kind | code-vibe 落点 |
|---|---|
| screenshot（多视口渲染） | `.sdd/acceptance/<id>/shots/`（1280/1440/窄分栏） |
| api-diff / network-har（分页/请求对照） | 证据文件与该条 O/N 一起，路径填入 coverage.tsv 证据列 |
| command-run（重跑输出） | coverage.tsv 证据列指向重跑输出文件，或 `.sdd/acceptance/<id>/runs/` |
| human-acceptance（人类验收包） | `.sdd/acceptance/<id>/human-acceptance-pack.md`（阶段 5 交付前） |

规则：coverage.tsv 的每个证据路径必须指向**真实存在的文件**（coverage_check.py 校验）；证据文件的内容满足本 skill 的 Evidence Kind 约束（如「分页」至少是 api-diff 或 network-har，不许首屏截图冒充）。

## 与 wish-programming 的分工

- 阶段 4 机械验收（独立 deny-write subagent 对照 requirements/存量清单）——本 skill 提供**证伪与证据标准**，不替代 journey/verify.sh/coverage_check。
- 阶段 5 用户 judge（真实渲染迭代）——本 skill 提供**验收包与走查姿势**，帮助用户在截图前自查。
- 只读评审：不修改实现；发现问题走 wish-programming 的切片修复。

## 边界

- 不替代 `dsh-ci-test-reliability`（测试级确定性/flake）；本 skill 管产品级验收（人可见的证据）。
- 不替代 `frontend-design`（设计产出）；本 skill 管验收侧。
- 设计类愿望的验收必须先过 `frontend-design` 的字段门（Job Brief/白名单），否则验收无对照。
