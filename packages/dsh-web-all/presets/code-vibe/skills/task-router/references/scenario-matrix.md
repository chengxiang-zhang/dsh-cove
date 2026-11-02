# 14 类场景 → 路径（兼容矩阵）

| # | 场景 | 路径 | 最小工件 | 用户门 |
|---|---|---|---|---|
| S1 | 问答/查数 | T0 | 无（内联证据） | 无 |
| S2 | 小 bug/失败测试 | T1 | 3 行报告 + diff | 无 |
| S3 | 单模块小功能 | T2-spec | spec+tasks+acceptance | ≤1 问 |
| S4 | 产品愿望/UI 改版 | T2-wish / T3-wish | quote+spec+design+tasks | 确认包 / judge |
| S5 | 续做/补全/收尾 | T2-wish / T3 | 差异清单+验收 | 视规模 |
| S6 | 数据/数仓/SQL/DDL | T2-spec（数据门） | acceptance+备份+dry-run | 动数据要授权 |
| S7 | 迁移/重构/选型 | TR → T2/T3 | 选型对比/迁移方案 | 方向拍板 |
| S8 | 运维/部署/演练 | T2-ops | runbook 六要素 | 生产授权 |
| S9 | 调研/审计/对比 | TR | findings+gap | 无 |
| S10 | 文档/报告/PPT | T1/T2-doc | 来源清单+事实核验 | 重要报告 1 问 |
| S11 | 基准/压测/长稳 | T2/T3 | 基准方案+读数 | 窗口授权 |
| S12 | 大清单/gap 收口 | T3-program | 账本+宪章+批次+板卡+HANDOFF | 开环确认 |
| S13 | 混合（调研→实施） | TR → T2/T3 | findings+handoff | 转档确认 |
| S14 | 事故 | TX | incident+复盘 | 立即报 |

**跨场景规则**：任何场景 D3=2 ⇒ 至少 T2；D1=2 且 D2=2 ⇒ 锁 T3；D4=2 ⇒ 先人闸。
