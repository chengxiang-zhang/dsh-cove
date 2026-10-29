# 产品包章节合同与剪枝

> 统一 `docs/product/modules/<slug>/` 层内写法。建包 → skill `design`。
> 旧包不强制回填；新写/大改某层时对齐本合同。
> 宿主模板不复制本文；仅 skills 为真源。

## 1. 骨架

```text
docs/product/modules/<slug>/
├── README.md
├── 01-experience.md
├── 02-product-model.md
├── 03-presentation.md   # 可同号改名
├── 04-runtime.md        # 薄：产品级约束
├── 05-delivery.md
└── 06-acceptance-matrix.md  # 可选：系列 Version Acceptance
```

读序钉死：体验 → 模型 → 呈现 → 运行时意图 → 交付。
语言后缀随宿主约定（默认无后缀）。域特化只许同号改名。

## 2. modules ↔ specs（真源）

| 真源 | 写什么 | 本层边界外 |
|------|--------|----------|
| `modules/<slug>/` | 产品决策（可超前） | 本版实现细节、关版 Test 全文 |
| `specs/<id>/` | 本版实施 + `tests.md` 阅卷 | 只改 Spec 不改产品语义 |
| system-map + 代码 | as-built | 愿景蓝图 |

**05** 索引 Spec `T-xxx`；Test / Oracle 正文只在 Spec `tests.md`。

## 3. 全集章节（适用则写；否则 N/A+理由或省略整层）

### README
一句话 + 状态/Gap/Spec · 读序地图 · 已拍板决策**索引** · 真源边界

### 01 体验
设计立场 · 角色/画像 · 操控面 · 用户旅程 · 可感配置/屏幕 · 体验非目标
（有 UI 时按 [`LOAD-MAP`](./design-standards/LOAD-MAP.md) 场景自检；启发式见 [`ux.md`](./design-standards/ux.md)）

### 02 产品模型
能力表 · 概念术语 · 核心对象与状态 · 权限/触发 · 冻结项 · 非目标

### 03 呈现
IA · 文案/视觉语义 · 组件/表面规格（无 UI → 整篇省略）
（有 UI → [`LOAD-MAP`](./design-standards/LOAD-MAP.md)；原则索引 [`visual.md`](./design-standards/visual.md)；品牌/DS 例外在 AGENTS）

### 04 运行时意图（薄）
进程/边界意图 · 关键路径语义 · 安全/观测约束
表结构、长锚点、API 字段全集 → Spec `plan.md`

### 05 交付
分期 · 配置/环境 · 联调检查 · 风险 · 关版 Test **索引**（正文在 Spec `tests.md`）

### 06 验收矩阵（可选 · 大模块）

多角色 × 多表面 / 多 Spec 系列的 **Version Acceptance 唯一 Oracle**（全角色全场景或等价浏览器剧本）。
写法通则：testing [`version-acceptance-matrix.md`](../../quality-review/references/version-acceptance-matrix.md)。
未触发系列验收时可省略；触发后 **不得**用单 Spec Build Pass 冒充本矩阵 Pass。

## 4. 剪枝表

| 类型 | 剪枝 |
|------|------|
| 纯后端 / 无 UI | 省略 03 |
| 纯体验愿景 | 可省略 04（README 声明） |
| 单层 ≤~80 行 | 单文件豁免 |
| 域特化呈现 | `03-cards` / `03-authoring` 等同号 |
| 调研附录 | `05-research` / `07-*` 等不占 01–05 合同位；**06 验收矩阵**占用可选合同位（见上） |

**硬门：** 04 概念保留在 04；交付不改号接到 03；关版以 Spec 验收为准（设计稿单独不构成关版）。

## 5. 新包自检（换靶：可感主路径，非齐套）

- [ ] **可感主路径卡**在（谁 / 触发 / 第一次成功结果 / 怎么观察到）——见 [`perceptible-path.md`](./perceptible-path.md)
- [ ] 「怎么观察到」**未**命中 [`scheme-antipatterns.md`](./scheme-antipatterns.md)
- [ ] 空层已省略（不为齐套建空文件）；简单诉求可用单页 / demand，不强制五层

~~章节齐全勾选表已删除（齐套 ≠ 质量）。~~
