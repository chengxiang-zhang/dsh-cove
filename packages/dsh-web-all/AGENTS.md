# AGENTS.md — dsh-web-all

dsh-cove 的唯一运行时实体插件：运行时 patch 只有一个实体行 `web-all`；独立 preset patch 可以声明 Agent 预设，但不得借此新增第二个功能实体行。代码按 DSH 注入位置组织。

## 结构（位置是第一维度）

- `src/index.ts` — host 半区装配器：注册全部服务域（`src/host/services/*`，每个
  服务域导出一个 `register(ctx)` 注册函数，由装配器统一调用；服务域不是插件，
  共享 web-all 的单一插件行）。对外契约（`/api/<能力>` 前缀、agent 工具名、
  settings namespace、data-dsh-plugin 语义）保持不变。
- `src/client/` — browser 半区，按注入位置分模块，每个位置只有一个模块负责
  该位置的全部注册与编排：
  - `src/client/sidebar/` — 侧栏（条目 + `sidebar.footer.action`），唯一注入者；
  - `src/client/settings/` — 设置（`settings.section` / `settings.plugins.tab` /
    `settings.plugin.item`），唯一注入者；
  - `src/client/conversation/` — 会话区（`conversation.input.*` / `chat.node` /
    `turnTail`），唯一注入者；
  - `src/client/compat.ts` — data-pane / data-dsh-frame 补标（保持行为契约）。
- `src/core/` — 跨位置共享纯逻辑（host + client 双 program 编译）。

## 新增 / 改动能力

- 新能力 = 在 `src/host/services/<name>/` 加一个服务域（`register(ctx)`）+ 在
  对应位置模块下加条目/卡/面板文件。**禁止**新建独立插件包、禁止在位置模块之外
  直接 `slots.inject` / DOM 注入——位置模块是唯一注入者。
- 命名按位置：位置模块目录名即位置；能力对外契约名（工具、路由、namespace）
  保持不变，内部实现按行为规格重写。
- 社区搬运代码保留 LICENSE 与作者署名；旧包代码只作行为参考，不复制粘贴。

## 提交前检查

```sh
pnpm typecheck
pnpm test
pnpm docs:check
```
