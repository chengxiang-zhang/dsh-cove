# Product Judgment（交互决策层）

> **有 UI 时先于视觉施工。** 蒸馏自 Vercel product-design / mblode `product-judgment`；措辞为本插件合同。
> 强度与加载义务 → [LOAD-MAP.md](./LOAD-MAP.md)。
> **本册管「做什么、怎么交互」；不管配色/字号**（→ craft-knobs · tokens · ai-tells）。

## 硬门

1. **Start with the job, not the pixels.** 先写下方 Job Brief；再选容器、控件、文案语气。
2. **填不出 `Job` / `Desired outcome` / `Consequence` → 停，问用户；禁止猜着画界面。**
3. **Decide before decorating.** IA、交互单位、动作后果、可达态未定 → 不得定视觉方向、不得输出线框当定稿。
4. **Evidence over taste.** 「现代干净」「高级感」不是决策依据。

## Job Brief（有 UI 必写；可极短）

落盘到产品切片 / Spec `contract.md` 或 `plan.md`（字段名可中英）。Shape 对话里至少口头齐这三项必填。

| 字段 | 必填 | 写什么 |
|------|------|--------|
| **User** | 建议 | 谁在操作；进来时已知什么 |
| **Job** | **是** | 用**用户的话**说要完成什么（非内部模块名） |
| **Current** | 建议 | 今天怎么做、卡在哪 |
| **Desired outcome** | **是** | 做成后系统行为长什么样 |
| **Success signal** | 建议 | 怎样算做成（可观察） |
| **Non-goals** | 建议 | 本切片明确不做 |
| **Object** | 建议 | 被作用的产品名词（扩展、成员、订单…） |
| **Action / Scope / Consequence** | **Consequence 必填** | 改什么、改多大、可否撤销 |
| **Permissions** | 触及权限时必填 | 谁能做；无权限时看见什么 |
| **Open decisions** | 有则写 | 未拍板项；禁止埋进实现细节 |

模板（可复制）：

```text
Job Brief:
- User: …
- Job: …
- Desired outcome: …
- Consequence: …（可逆 / 不可逆 / 影响谁）
- Permissions: …（若触及）
- Non-goals: …
- Open: …
```

## 人话验收（Plain acceptance）

在定控件前，用 **2–4 条人话** 写清「怎样算这个面可用」。禁止验收句依赖实现黑话。

| 好 | 坏 |
|----|----|
| 一次搜索勾多人，点一次「添加」即可加满一批 | 投影主体选择完成 |
| 打开 3 秒内能分清：谁能用 / 怎么拿到 / 怎么改 | 高风险策略配置正确 |
| 加人与加部门同一入口，无需先切「类型」 | ACL subject 类型切换后多选 |

配置 / 授权 / 分发 / 发布范围类界面：**至少**覆盖「谁 · 怎么拿到或生效 · 怎么改错」。

## 稳定规则（引用用 ID）

评审、切片、Verify 发现问题时引用下列 ID（勿发明新 ID；缺口记 coverage gap）。

### 交互单位

| ID | 规则 |
|----|------|
| `rule/job-before-chrome` | 未齐 Job Brief 三必填 → 禁止定壳/线框定稿 |
| `rule/interaction-unit` | 交互单位跟用户任务走，不跟内部类型表走（例：搜人/部门/组同一入口批量加，而非先切 tab） |
| `rule/batch-same-search` | 批量添加：同一次搜索多选 → 一次确认；禁止「搜一个加一个」当主路径 |
| `rule/control-matches-cardinality` | 2–3 个静态互斥选项 → radio/分段（选项可见）；勿用藏选项的 select |
| `rule/inline-before-modal` | 能行内/就地展开则勿上 Modal；Modal 只打断焦点决策 |
| `rule/smallest-intervention` | 先更好默认 → 行为自动完成 → 复用已有模式 → 最后才加新 UI |
| `rule/one-primary-action` | 一屏/一抽屉一个主任务与一个主 CTA |

### 后果与范围

| ID | 规则 |
|----|------|
| `rule/name-object-scope-consequence` | 动作文案说清对象、范围、后果；禁空壳「确定 / OK / 提交」 |
| `rule/separate-access-vs-delivery` | 「谁可见/可用」与「怎么发到手上（自装 vs 默认开启）」是两件产品决定，勿揉成一词 |
| `rule/preserve-mental-model` | 不改用户心智除非解决已验证问题；切「全员/指定」等模式须说明已选数据如何收敛 |

### 语言与状态

| ID | 规则 |
|----|------|
| `rule/no-impl-jargon` | UI 与验收禁实现黑话（主体、投影、registry、shadowing、高风险策略码等）；用人话或产品名 |
| `rule/cover-reachable-states` | 设计产品真实可达态：空/载/错/无权限/极端数据；不只 happy path |
| `rule/3s-ia` | 打开主配置面约 3 秒内应能回答：我在哪、主任务是什么、怎么改 |

## Smallest coherent intervention（加 UI 前）

按序问：

1. 更好的默认能否免选？
2. 系统能否自动做对？
3. 现有模式能否复用？
4. 仍不够 → 再加新 UI。

## 与其它册的边界

| 本册之后才读 | 用途 |
|--------------|------|
| [craft-knobs.md](./craft-knobs.md) | Design Read / 旋钮 |
| [copy.md](./copy.md) | 动词与错误句式（仍守 `rule/no-impl-jargon`） |
| [ui-page-gate.md](./ui-page-gate.md) | 写页前评审块（须含 Job Brief） |
| [LOAD-MAP.md](./LOAD-MAP.md) | 场景加读与字段门（页种/控件册已归档） |

## 自检

- [ ] Job / Desired outcome / Consequence 已填（或已向用户提问）
- [ ] 人话验收 2–4 条，无实现黑话
- [ ] 交互单位与批量规则已选，而非默认「类型 Tab + 单选」
- [ ] 触及权限/分发时：谁能用 vs 怎么拿到 已拆开
- [ ] 未跳到 tokens / ai-tells 定视觉
)
