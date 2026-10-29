# Design Standards Pack

插件默认可执行设计底线。有 UI 时**先读 [LOAD-MAP.md](./LOAD-MAP.md)**（字段门控、豁免、场景必读的**唯一真源**）。
宿主品牌写在 `AGENTS.md` / 可选 `docs/product/DESIGN.md` + `PRODUCT.md`。

## 册

| 路径 | 内容 |
|------|------|
| **[LOAD-MAP.md](./LOAD-MAP.md)** | **任务→必读（入口）** |
| [product-judgment.md](./product-judgment.md) | **交互决策层**：Job Brief · 人话验收 · 交互单位（先于视觉） |
| [craft-knobs.md](./craft-knobs.md) | Design Read · variance/motion/density · visitor_mode |
| [change-control.md](./change-control.md) | refinement/redesign · material 门 · **Polish 轨** |
| [debug-playbook.md](./debug-playbook.md) | UI 回归 / 错缝 |
| [anchor.md](./anchor.md) | 参考锚点（Build 前硬门；Shape 可后置） |
| [copy.md](./copy.md) | UX Writing |
| [tokens/](./tokens/) | 封闭尺度与色角色 |
| [audit/](./audit/) | ai-tells |
| [exemplars/](./exemplars/README.md) | 正反例 |
| [ui-page-gate.md](./ui-page-gate.md) | 写页面前**评审输出模板**（加载义务见 LOAD-MAP） |
| [visual.md](./visual.md) | 原则索引（非施工入口） |
| [ux.md](./ux.md) | 体验启发式（非施工入口） |
| [system-architecture.md](./system-architecture.md) | 架构通则 |

> 历史 `pages/` · `components/` · `surfaces/` 在 `references/_archive/design-standards/`（非施工必读）。

## 覆盖顺序

```text
Spec ≫ AGENTS.md / docs/product/{PRODUCT,DESIGN}.md ≫ docs/architecture/ ≫ 本包默认
```

## Surface + page_kind

```text
Job Brief 未齐 → 不定视觉、不输出线框定稿（product-judgment）
未声明 surface → 不定视觉、不写新页
未写 Design Read → 不定视觉（craft-knobs）
合同写 UI surface + page_kind|motif；Build 前 anchor 必填；改存量先 change-control
```

场景表、Rail 强度、豁免 → **[LOAD-MAP](./LOAD-MAP.md)**（勿在本 README 复述强度表）。

## 机读

[ui-surface.checklist.json](./ui-surface.checklist.json) · [plan-architecture.checklist.json](./plan-architecture.checklist.json)
`check_spec.py`：有 UI 缺 surface → fail；缺 Job Brief / Design Read / page_kind|motif / anchor → warn。

## 明确不做

- 不新建 Design Rail；不在 templates 复制本包长文
- 不搬宿主组件库 API 全文 / Vercel 品牌 CSS
- 不把已归档页种/控件册重新挂回常驻必读
