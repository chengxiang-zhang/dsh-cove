---
name: tech-design
description: Use after architecture is frozen (or for a single-module change touching interfaces/data/contracts) to define HOW it is implemented — 模块划分/接口冻结/数据变更/迁移与回滚/负控/可测性. Produces tech-design.md ready for change-spec planning. Do NOT use for architecture trade-offs (use architecture-design) or simple one-file fixes (use fix-loop).
---

# 技术设计（Technical Design）

> 架构定"形状"，技术设计定"接缝"：接口、数据、迁移、回滚、怎么测。

## 何时用

- 架构已冻结，进入实现方案；
- 单模块但涉及接口/数据/契约变更（T2-spec 的设计件）。

## 工件（`docs/design/<id>/tech-design.md`）

1. **模块与职责**：改哪些模块、各自职责、不碰什么；
2. **接口冻结表**：签名/入参/出参/错误码/兼容策略；
3. **数据变更**：schema/迁移脚本/回填/幂等/备份；
4. **迁移与回滚**：步骤、窗口、回滚命令、数据可逆性；
5. **可测性**：目标测试、负控（注入缺陷必红）、读回方式；
6. **风险与观测**：失败模式、监控指标、告警。

## 评审（tech review）

- reviewer：tech-lead-reviewer + sre（涉数据/部署时）；
- 判据：接口契约完整、迁移可回滚、负控可执行、观测到位；
- 通过后交 `change-spec` 出 spec/tasks/acceptance 或 `large-backlog-program` 派工。

## 反例

- 把架构决策塞进技术设计（该写 ADR）；
- 只写 happy path 无回滚；
- 接口"回头再说"。
