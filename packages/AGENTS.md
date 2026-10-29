# AGENTS.md — 包级规则（packages/）

本层规则补充根 [AGENTS.md](../AGENTS.md) 的全局约定，适用于 `packages/` 下唯一的运行时实体。修改包前先读本文件；包特有规则写在该包自己的 `AGENTS.md`。

## 包形态

- **唯一运行时实体（dsh-web-all）**：全家桶所有 first-party host/browser 能力共享 `web-all` 这一条 Cordis 生命周期，按 dsh 注入位置组织（见其 AGENTS.md）。独立 preset patch 可以声明 Agent 预设，但不得新增第二个功能实体行。新增能力直接进入本包。
- **host / client 半区分层**：`dsh-web-all/src/index.ts` 是 host 装配入口，`src/host/services/` 按服务域组织，`src/client/` 按 sidebar / settings / conversation 注入位置组织，`src/core/` 是两侧共享的纯逻辑。新增运行时代码必须落到这些 owner 之一。
- **exports 约定**：运行时实体的 `exports` 提供 `.`（host）、`./client`（浏览器半区）、必要时 `./invariant`；`./src/*` 用于测试引用。不得把旧 runtime 入口重新暴露为独立插件，也不得新增第二个包。

## SDK 与构建约束

- **只基于官方 NPM SDK**：类型来自 `@deepseek-ai/*` devDependencies（node_modules 解析）；peerDependencies 声明运行时注入的服务；禁止 tsconfig 指向任何 DSH 源码 checkout。
- **共享构建预设**：所有 tsdown 包 import `shared/tsdown.client.ts`，禁止复制到包内；tsconfig 保持 host/client/core 边界清晰。
- **运行时共享模块**：`host/`（dsh-home、git-runner、loopback、http）与 `client/`（sse-leader）的事实源在 `shared/`；包内带 generated 头注释的副本由 `scripts/sync-shared.mjs` 同步，禁止手改。改 shared 源后重跑同步，`test:scripts` 含 drift 门禁。shared 只承载不含 `@deepseek-ai/*` 依赖的纯逻辑：一旦某模块引用官方 SDK，它属于消费包自己的位置模块。
- **浏览器 bundle 纯度门**：`@deepseek-ai/*` 只能 type-only 导入；值导入只允许平台种子表成员（react / cordis / ui-slots / ui-primitives，见 `shared/web-platform.ts`）。跨能力协作走 Cordis 服务（`ctx.slots` / `ctx.sessions` / `ctx.workspaces`）或由位置模块传入，不走 package-level value import。
- **样式**：CSS Modules（`*.module.css`）经 lightningcss 编译进 bundle；不引入 UI 框架样式库。填充主按钮一律用主按钮三件套（`--dsw-alias-button-primary-fill` / `--dsw-alias-button-primary-hover` / `--dsw-alias-label-primary-foreground`，明暗两组），不得把 `--dsw-alias-brand-primary` 当填充色。

## Agent 公告约定（issue #839）

- 会向 agent 系统提示注入公告（systemPrompt section）的能力必须提供 `announceToAgent` 开关：schema 默认 `false`，用户在设置界面（或 profile patch）按需开启；开关必须经 `installSettingsSection`（或等价的自定义设置卡）暴露到 Web 设置界面并即时生效。
- 公告文本只陈述能力、约束与触发词，不包含与当前任务无关的长段声明。
- **section/context 文本只准静态或引用已注册变量**：`systemPrompt.section` / `.context` 的 `text` 会被 DSH 严格插值。禁止把动态数据原文拼进 section text；动态内容一律注册 `systemPrompt.variable(name, provider)` 并在 section 里引用 `{{name}}`。变量名须匹配 `/^[a-z][a-z0-9_]*$/`，且不得与 DSH 内建 `provider` / `model` / `cwd` 重名。`pnpm test:scripts` 的 system-prompt-audit 门禁拦截字面量违规。

## 测试纪律

- 每个发布包必须有 `vitest run` 可通过的测试（`pnpm test` 全仓门禁）。行为变化必须带测试；纯 UI 展示层的冒烟测试可放宽为轻量挂载断言。
- `tests/` 放测试，测试文件不得依赖 DSH 源码 checkout 的 fixture。
- `dsh-web-all` 的 sidebar / settings / conversation 位置模块是唯一注入者；行为变化必须带测试，位置模块的挂载断言在包内 tests 覆盖。

## 语义属性约定（L2，issue #506）

- 运行时 UI 根容器与关键部件必须输出语义属性：根容器打 `data-dsh-plugin="<能力短名>"`，部件打裸值 `data-dsh-part`（归属交给 plugin 属性，如 `column` 而非 `task-board-column`）。
- 不复用官方 `data-plugin`（它标注 style 标签归属，语义不同）；body/html 级属性不属于 surface/part/plugin 枚举。

## 双语纪律

- 发布包 README 中英配对：`README.md`（英文）+ `README.zh.md`（中文）+ `README.i18n.yaml`（配对一致性记录）。规则见 [docs/AGENTS.md](../docs/AGENTS.md) 与 [docs/i18n.md](../docs/i18n.md)。
- 包内 UI 文案 i18n：`zh` 字典为 key 源，`en` 键集完整对照，经 `ctx.locale.register` 注册；错误文案与官方 DSH 词汇对照。

## 安全语义

- 涉及密钥、凭据、远程执行或令牌撤销的 `dsh-web-all` 服务域修改安全语义时，必须同步更新对应用户文档与测试，保持 fail-closed 行为。

## 包级 AGENTS.md

- 包有跨目录规则、复杂构建链或安全模型时，在该包写 `AGENTS.md`。
- 包级 `AGENTS.md` 只写该包特有规则，不重复本文件与根文件内容。
- `dsh-web-all` 的具体注入位置和装配纪律以 [dsh-web-all/AGENTS.md](dsh-web-all/AGENTS.md) 为准。
