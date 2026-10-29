# UX（用户体验默认）

> 社区锚点：ISO 9241-11、[Nielsen 10 Usability Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)。
> **原则/启发式真源**（非 UI 施工入口）。有界面施工 → [LOAD-MAP.md](./LOAD-MAP.md)。
> Verify 接线 → [`skills/testing/references/ux-standards.md`](../../../quality-review/references/ux-standards.md)。

## 核心原则

**合格体验 = 指定用户在真实情境下能有效、高效、满意地完成目标。**
有控件 / Toast / API 200 / 空态文案 **单独均不算**达成。

- 验证 / 设计都围绕用户 Job，不只围绕控件或接口；
- 使用目标角色、真实入口和代表性数据心智；
- 必须考虑系统反馈、错误恢复和完成感；
- Shape 阶段就把失败与权限路径写进产品切片，再交给 Plan/Verify。

## 可用性度量（ISO 9241）

| 维度 | 含义 |
|------|------|
| Effectiveness | 能否真完成目标 |
| Efficiency | 时间、步骤、认知成本 |
| Satisfaction | 是否顺、是否愿意再来 |

## 检查维度

| 维度 | 最低问题 |
|---|---|
| 可发现 | 用户能找到正确入口吗？ |
| 可理解 | 文案、状态和下一步是否明确？ |
| 可控 | 用户能取消、返回或修正吗？ |
| 反馈 | 操作后是否及时显示真实状态？ |
| 错误恢复 | 失败是否说明原因和可行下一步？ |
| 一致性 | 相同概念、动作和权限是否一致？ |
| 可访问 | 键盘、焦点、对比度、语义（宿主 a11y + ai-tells） |
| 完成感 | 用户能确认 Job 已完成且知道影响范围吗？ |

## Nielsen 十条启发式（严重度 0–4）

0 不是问题 · 1 妆容 · 2 小 · 3 重要 · **4 灾难（阻断核心 Job → Job Fail）**。

| # | 启发式 | 评分时问什么 |
|---|--------|--------------|
| H1 | Visibility of system status | 是否知道自己在哪、系统在干什么？ |
| H2 | Match system ↔ real world | 是否人话？顺序是否符合任务心智？ |
| H3 | User control and freedom | 误操作能否撤销/退出？ |
| H4 | Consistency and standards | 一词一义？符合平台/行业习惯？ |
| H5 | Error prevention | 高代价错误是否被挡住？ |
| H6 | Recognition rather than recall | 关键信息是否可见？是否逼人记 UUID？ |
| H7 | Flexibility and efficiency | 新手可起步、熟手有捷径？ |
| H8 | Aesthetic and minimalist | 无关信息是否淹没关键信息？ |
| H9 | Help recover from errors | 错误是否人话并给下一步？ |
| H10 | Help and documentation | 最好自解释；帮助是否任务向？ |

## Shape / 产品包自检（有 UI 时）

写或改 `01-experience` / `03-presentation` 时对照：

- [ ] 主 Job 的成功、失败、权限拒绝路径都有可感结果
- [ ] 反馈与完成感可观察（不只「点了按钮」）
- [ ] 无逼用户记忆内部 ID / 技术术语（除非角色就是运维）
- [ ] 与宿主已有导航、用词一致，或显式记录Breaking 变更

## 反模式

| 反模式 | 正确做法 |
|--------|----------|
| Toast / 「已安装」文案 → 成功 | 用户是否达成 Job？ |
| API 200 → 成功 | 发现面用户是否认得出变化？ |
| 旁路脚本顶替主通道 | 目标产品路径是否真走通？ |
| 仅用启发式 Pass 数关版 | Jobs 有效性 + 无开放严重度 4 |
| Shape 只画快乐路径 | 失败与权限必须进切片 |

## 不适用

纯后端无 UI、纯文档、纯 CI：`run.md` 写 `UX: N/A` + 理由；Shape 可跳过本册详细自检。
