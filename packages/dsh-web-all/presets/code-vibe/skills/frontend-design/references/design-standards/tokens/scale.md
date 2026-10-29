# Token Scale（封闭尺度）

> 无宿主设计系统时的默认阶梯。只许表内值；半档（如 10、14px gap、`text-[13px]`）视为违规。
> 覆盖 → [README.md](./README.md)。

## 1. Spacing（基单位 4）

| Token 角色 | px | 典型用途 |
|------------|-----|----------|
| `space-1` | 4 | 紧挨控件内边距、图标与文字微距 |
| `space-2` | 8 | 控件内默认、密集组内 gap |
| `space-3` | 12 | 表单字段组、chip 间距 |
| `space-4` | 16 | 区块内默认 gap、表头/单元格常用垫 |
| `space-5` | 24 | 卡片/分组内边距、段间 |
| `space-6` | 32 | 大分组、页头与内容 |
| `space-7` | 48 | 章节级分隔 |

**无线关系（名称固定，值取自上表或宿主等价物）：**

| 名 | 含义 |
|----|------|
| `--page-pl` / `--page-pr` | 内容区左右垫；与侧栏首列对齐时必须同源 |
| `--detail-px` | 详情阅读页水平垫（可 ≥ list 页） |
| `--row-h` | 密集行高（表行/导航行） |
| `--top-row-h` | 顶栏 / 侧栏品牌行高 |
| `--slot-size` | 图标对齐槽（槽对齐，不是图标本身乱改尺寸） |

组件内禁止裸写 `padding: 13px` 等；用上表或 `calc(var(--…))`。

### Wireless（硬编码 = bug）

可见 **间距 / 高度 / gap / 字号 / 圆角 / 图标外槽** 必须是表内 token、宿主变量或 `calc(token…)`。
组件源码里散落魔法 px（含 Tailwind 任意值 `p-[13px]`、`text-[13px]`、`h-[37px]`）→ **当作 bug 修**，不是风格偏好。
验收：抽主路径组件，对非常量 token 的裸长度零容忍（图表库内部除外，外层尺寸仍锁 token）。

## 2. Control height

| Token | px | 用途 |
|-------|-----|------|
| `control-xs` | 28 | 密级 chip、次要图标钮、密表行控件 |
| `control-sm` | 32 | **product 默认**：按钮、搜索、多数 Input |
| `control-md` | 36 | 舒适表单行、表单元格内控件 |
| `control-lg` | 44 | 顶栏行；**consumer 主 CTA / 触控主目标** |

## 3. Type（字号阶梯）

| 角色 | px | 用途 |
|------|-----|------|
| `type-xs` | 12 | 次要元数据、时间戳 |
| `type-sm` | 14 | **product body 默认**；表单元格、表单 label、导航项 |
| `type-md` | 16 | consumer 主路径正文；callout |
| `type-lg` | 18 | 详情内小节标题 |
| `type-xl` | 20 | 页标题（少用） |
| `type-2xl` | 24 | 章节/consumer 强调标题 |
| `type-display` | 30 | KPI 大数、growth 主标题（克制使用） |

字重仅：`400` / `500` / `600`。
**product 禁用 `700`（bold）** — 14px 上过重。
数字列 / 对比列：`font-variant-numeric: tabular-nums`。

## 4. Radius

| 角色 | px | 用途 |
|------|-----|------|
| `radius-none` | 0 | 齐平密表、需硬边时 |
| `radius-xs` | 2 | 微 |
| `radius-sm` | 4 | 小标签 |
| `radius-md` | 6 | **默认控件**（按钮/输入） |
| `radius-lg` | 8 | 卡片/模态外框上限（product） |
| `radius-full` | 9999 | pill / 状态胶囊 |

内外圆角：内 ≤ 外。

## 5. Icon

| 角色 | px |
|------|-----|
| `icon-sm` | 14 |
| `icon-md` | 16 |

同一界面单一 icon 家族与单一 stroke；禁止混用描边粗细。

## 6. Surface 差量（尺度）

| | product | consumer in-product | consumer growth |
|--|---------|---------------------|-----------------|
| 默认 body | 14 | 16（可读优先） | 按标题角色，勿半档 |
| 默认控件高 | 32 | 主行动 ≥44 | CTA ≥44 |
| 密度 | 偏 compact | motif 决定 | 首屏留白服从构图，非密表 |
