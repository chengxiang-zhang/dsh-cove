# Version Acceptance 矩阵（全角色 × 全场景）

> 蒸馏自人工纠正后的高质量实践（组织扩展 `06-acceptance-matrix`、BI 浏览器走查剧本、权限破坏性生命周期等）。
> **可选用例设计合同**——不是每个 Build 切片的默认义务。
> 日常单 Spec 仍走 `tests.md` + [`falsify-checklist`](./falsify-checklist.md) + [`verification-loop`](./verification-loop.md)。

## 何时必须启用（触发）

命中任一即须**先设计矩阵（或等价剧本），再跑、再结案**：

1. 用户明示：**整体验收** / **全角色全场景** / **不要敷衍** / **系列 Version Acceptance**；
2. **多 Spec 组成同一产品切片**（拆包交付后的一次关版）；
3. **多角色 × 多表面** material 能力（管理面配置 + 成员面生效、权限/分发/投影等）；
4. 既往曾用「有条件 Pass / UX Pass」软结案，用户打回要求重验。

**不启用：** 单切片 Build、Polish/trivial、纯后端无多角色、用户只批单条 Repair 回验。

未触发时禁止用本文件当借口扩成无限走查；触发后禁止用单 Spec `tests.md` 绿冒充系列 Pass。

## 与相邻真源

| 概念 | 证明什么 | 真源 |
|---|---|---|
| Build Validation | 本 Spec 实现 + 单测/行为 | Spec `tests.md` / Build `run.md` |
| Version Acceptance（本页） | 产品结果在真实角色×场景下成立 | 产品包矩阵/剧本 + 执行记录 |
| Production（P6） | 目标环境关键路径 | deploy + verification-loop |
| 产品回归（可选） | 长期主旅程不回退 | [`product-regression`](./product-regression.md) |

**硬门：** Build Pass / vitest 绿 / 管理面点击通 **≠** Version Acceptance Pass。

## 落盘位置（宿主）

优先产品包内一页（大模块建议 `06-acceptance-matrix` 或 `05` 下剧本），作为系列**唯一 Oracle**：

```text
docs/product/modules/<slug>/06-acceptance-matrix.md   # 或宿主语言后缀
```

亦可 `…/research/浏览器走查用例-<日期>.md`（步骤型剧本）。
执行记录与证据写入相关 Spec `run.md` / `evidence/`；**不得**改矩阵 Oracle 来刷绿。

## 设计骨架（按序写完再跑）

### 1. 验收铁律（先于用例表）

至少钉死（可增不可软化）：

| 铁律 | 含义 |
|---|---|
| 消费侧生效 | 配置/授权类必须看**消费角色**结果翻转，不能只看管理面徽章 |
| Before → 动作 → After | 缺 After 观察 = Unverified，不得 Pass |
| 概念不混谈 | 如「看见 ≠ 能用 ≠ 已安装 ≠ 运行注入」——按产品模型拆开测 |
| 单测/点击不足 | UI 通 + 单元绿不足以关系列 |
| Blocked 不降级 | 真机/租户缺失标 Blocked，mock 另列，不冒充 Pass |
| 冷路径诚实 | 用户失败路径（冷查/空缓存/首屏）必须覆盖；禁 HIT 冒充 |

### 2. 角色表

| 代号 | 产品角色 | 用途 |
|---|---|---|
| A | 管理/治理侧 | 写配置、授权、危险操作 |
| M | 主消费角色 | **生效 Oracle 主观察者** |
| O | 无授权/越权对照 | 负向 |
| N | 未登录（若适用） | 入口与 API 负向 |
| 外 | 外部系统真机（若适用） | 审批/Bot 等；不通则 Blocked |

账号口令只指向宿主 `AGENTS.md` / 约定凭据文档；有可复用凭据则 Agent **自行切换**，禁止把换号验收派给用户。

### 3. 表面表（Surface）

列出本能力真实入口：Web 路径、API、Worker、第三方控制台等。用例必须落到具体表面，禁止「系统里测过了」。

### 4. 夹具（跑前准备）

为 P0 准备最小可区分夹具（空授权、单部门、全员、排除、停用…按域裁剪）。
命名可复现；**禁止**用生产业务数据做破坏性用例。

### 5. 用例表列

每行：`ID | 角色 | 表面 | Given | When | Then（可观察） | Oracle/取证 | Spec 映射 | Pri(P0/P1/P2)`

或步骤剧本列：`步 | 你做什么 | 过 | 挂`（适合强 UI 分窗/续载；「挂」列必须可打假）。

### 6. 优先级

- **P0**：不过则系列不得 Pass
- **P1**：应过；失败进 Repair；书面接受前不关系列
- **P2**：边界/回归；记册
- **Blocked**：环境缺失；保持 Blocked

## 执行铁律

1. **先设计后跑**；矩阵未钉死禁止结案。
2. 按矩阵序执行；P0 未齐禁止「有条件可交付」。
3. 授权/回收/状态变更：必须留下消费侧 **两态差** 证据。
4. 浏览器：真打开宿主 URL；关键控件真点击；Network/API 与 Then 对齐（见 [`browser-verify`](./browser-verify.md)）。
5. 破坏性权限场景：可注册临时用户走生命周期；测完停用；证据落盘。
6. 既往软结案在矩阵启用后 **作废**，须重跑。

## 结束信号（系列）

```text
矩阵真源: docs/product/modules/<slug>/06-…（或剧本路径）
P0 结果: 全 Pass | 失败列表 | Blocked 列表
探活执行者: agent
需要用户做什么: 无需动作 | 批准 Repair | 真人/租户授权
verify-deliver: ran (check_spec --closing exit 0)   # 系列关版宣称可交付前必有（钉 1）
```

### P0 行级结果表（系列关版必需）

触发本矩阵后，结案前须在执行记录（相关 Spec `run.md` / `evidence/`）留下**逐行**结果，不得只写「P0 全过」一句话：

| P0 ID | 角色 | 表面 | Result | 两态/证伪摘要 | Evidence（`kind=`） |
|---|---|---|---|---|---|
| … | M/A/… | … | Pass\|Fail\|Blocked | Before→After 或失败点 | kind=… · |

缺任一行 Result，或 P0 有 Fail/Blocked 未书面接受 → **不得**系列 Pass / 可交付。
Build 轨禁止改本矩阵 Oracle（钉 2）；观察只写入执行记录。

缺消费侧翻转证据 → 不得系列 Pass。

## 反模式

| 禁止 | 来源教训 |
|---|---|
| 四包 Spec 各报 Pass 就报系列完成 | 组织扩展：拆包后须矩阵关版 |
| 只测管理抽屉文案 | 「授权后成员侧会真生效吗」 |
| 暖缓存/HIT 当冷查 Pass | BI：134s 冷查 vs 1s HIT |
| 请用户硬刷发现全员/部门是否还在 | 部署后甩发现 |
| 无限加场景却不写 P0 边界 | 矩阵要全，但仍分 P0/P1/P2 |
