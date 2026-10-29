# Validation Report

> 正式验收落盘结构的唯一真源是宿主 Spec 模板
> `docs/specs/<id>/run.md`（scaffold 来自插件
> `templates/docs/specs/_template/run.md`）。
>
> 本文件**不**维护第二份报告骨架。Verify / Incident 写结论时直接编辑对应 Spec 的
> `run.md`（结构：执行态 → 结果 → 关版 → 终态）。预期 Oracle 在 `tests.md`；
> 批次结果、追踪矩阵、Fail/Repair、关版与终态均以 `run.md` 为准。

## 必读约束

- Fail 分类与下一 Rail → [`evidence-contract.md`](./evidence-contract.md) §5
- Evidence Kind / 禁纯 smoke Pass → 同文件 §1.1；执行 → [falsify-checklist.md](./falsify-checklist.md)
- Delivery Target / 完成声明词汇 → [`evidence-contract.md`](./evidence-contract.md)「Delivery Target 闸门」
- 报告必须先写 PM 验收摘要（关版），Matrix / Acceptance 写在 `## 终态`；内部状态不能替代
  「可交付 / 不可交付 / 受阻」的前台结论
- 所有适用 Test 有终态 → 只能声明 `matrix-accounted`；关版条件满足 →
  `acceptance-passed`（二者都不是 Delivery Target）
- Oracle 写在 `tests.md`；观察结果只写 `run.md`
- Evidence 列格式：`kind=<名> · <路径>`；Pass 禁止仅 `window-smoke` / `health`
- 「已验证的用户结果」须含两态观察差；Build 轨不得写「可交付」
