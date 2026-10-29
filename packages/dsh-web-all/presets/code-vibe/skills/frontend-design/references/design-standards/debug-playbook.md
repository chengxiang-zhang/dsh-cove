# UI debug playbook（回归 / 错缝 / AI 脸）

> 有界面回归、错缝、验收 Fail 的视觉类问题用本册；不替代 Skill `debug` 的线上排障。
> 先 [LOAD-MAP](./LOAD-MAP.md)，再对本表。

## 1. 分流

| 症状 | 先读 | 常见根因 |
|------|------|----------|
| 「像 AI 默认脸」 | [audit/ai-tells.md](./audit/ai-tells.md) | 紫/glow/四等 KPI/grain |
| 侧栏与主区错缝、顶栏不对齐 | [anchor.md](./anchor.md) + 宿主壳量测 | 垫不同源、负 margin |
| 空态像筛选零 / 整页转圈 | [copy.md](./copy.md) + product-judgment 交互单位 | 空态未两分 |
| Modal/Sheet 乱用、跳动 | product-judgment（先交互单位再容器） | 未顶锚、假 dim |
| 表列抖、筛选丢 | LOAD-MAP 列表场景 + 合同 page_kind | 非真 table / URL 未同步 |
| 焦点看不见、表单无 label | ai-tells + 宿主 a11y 约定 | outline 被干掉 |
| 文案含糊、错误无下一步 | [copy.md](./copy.md) | 未走 What/Why/Next |

## 2. 测量步骤（product 壳）

1. 固定 viewport（如 1280×800）与同一壳态（侧栏开/关各测一次）。
2. 对顶栏、侧栏品牌行、工具首行、`--page-pl` 首列做 `getBoundingClientRect`。
3. 偏差 ≥2px → Fail；用同源 token/`calc` 修，**禁止**负 margin 糊缝。
4. 再测 loading→loaded：稳定锚点 centerY 应一致。

可选：在 DevTools Console 注入临时测量脚本对比两态坐标；结果记入 `run.md`（通过/坐标差）。

## 3. 修复纪律

- 一次只修一类根因（先几何再色再文案）。
- Hotfix UI：**refinement** 默认（见 [change-control.md](./change-control.md)）。
- 修完：ai-tells 再扫 + LOAD-MAP 场景行 + 一次浏览器通道。

## 4. 自检

- [ ] 症状已映射到本表分流
- [ ] 有测量或截图前后对比
- [ ] 未引入第二套视觉语言
