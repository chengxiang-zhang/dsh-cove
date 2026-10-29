# UI Page Gate（评审输出模板）

> 新建/大改用户可见页（或含表单的 Dialog/Sheet）时，写业务 UI 前用本模板做评审。
> **加载义务与字段强度 → [LOAD-MAP.md](./LOAD-MAP.md)**（本文件不另定硬门）。

**硬门：** 禁字段平铺成 UI；先产品判断与 IA；评审确认前不写页。

## 何时启用

新建路由、大改布局/主任务、含表单的 Dialog/Sheet/Drawer。
trivial / Polish / 非 material refinement → 见 LOAD-MAP **豁免**；可不跑完整评审。

## 阶段〇：Job Brief（硬门）

先完成 [product-judgment.md](./product-judgment.md)：Job / Desired outcome / Consequence 必填；2–4 条人话验收。
填不出 → **停，问用户**；禁止进入阶段二画 IA/控件。

## 阶段一：五问 → 页面定位

1. 谁 2. 核心任务 3. 频率 4. 决策信息 5. 失败边界 → 一句页面定位。
必填字段按 LOAD-MAP 字段门控表落盘（Job Brief、Design Read、surface、page_kind/motif、anchor…）。

## 阶段二：IA

| 决策 | |
|------|--|
| 交互单位 | 跟 Job 走，不跟内部类型表（product-judgment `rule/interaction-unit`） |
| 骨架 | 服从合同 `page_kind`/`motif`；混任务拆页；redundancy hunt（见 [LOAD-MAP](./LOAD-MAP.md)） |
| 主次 / 披露 / 密度 / 路径 | ID 优先选择器 |

覆盖层：先定交互单位与批量规则，再选容器——新建短表→Modal；行预览→Sheet；单字段→行内。

## 阶段三：探测宿主资源

AGENTS / PRODUCT.md / DESIGN.md / 现有 API 与组件；DS 绑定见 AGENTS。

## 阶段四：评审块（确认前停）

```text
### 页面设计评审：[名]
Job Brief（User / Job / Desired / Consequence / Permissions）：
人话验收：…
Design Read：…
定位：…
UI surface / page_kind|motif / shell / visitor_mode：
knobs（v/m/d）：
change（new|refinement|redesign）：
anchor / diverge：
设计决策（含交互单位 / 引用 rule/*）：…
信息架构：…
字段清单：…
主干流程：…
业务四态 + 交互五态：…
覆盖层选择：Modal|Sheet|行内|—
待确认：…
```

## 阶段五：实现 / 验收

按 LOAD-MAP 场景行加载册；宿主 DS 优先；输出前扫 ai-tells；文案守 copy.md。
验收：浏览器走主干 Job；对照 LOAD-MAP 场景行 + ai-tells。
