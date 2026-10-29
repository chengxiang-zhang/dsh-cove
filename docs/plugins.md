# 在单实体插件中增加能力

`@dsh-cove/dsh-web-all` 是 dsh-cove 家族唯一运行时实体插件。新能力直接进入该实体，不创建独立 Cordis bundle，不生成第二条插件行，也不通过聚合器拼装子插件。仓库整体布局、运行时模型与访问围栏见 [architecture.md](architecture.md)。

## 位置优先的目录

浏览器代码以 DSH 注入位置作为第一维度：

- `packages/dsh-web-all/src/client/sidebar/`：左侧栏面板（`sidebar.panellist` + `main`）与原生右栏页面（`sidebar.right.pane.tab`）；
- `packages/dsh-web-all/src/client/settings/`：`settings.plugins.tab`（飞书接入与运行结束通知两个标签页）；
- `packages/dsh-web-all/src/client/conversation/`：输入区（`conversation.input.dock`）、会话头部动作（`conversation.session.header.actions`）与分支选择器；
- `packages/dsh-web-all/src/core/<domain>/`：host 和 browser 共同使用的纯协议与算法。

每个位置只有对应位置模块执行 slot 或 DOM 注册。能力文件导出组件、数据控制器或挂载函数，由位置模块统一排序和装配；能力文件不得自行向另一个位置注入。

## Host 服务域

新增 host 能力时：

1. 在 `packages/dsh-web-all/src/host/services/<domain>/` 实现 `register(ctx, deps): () => void`；
2. 跨端 wire 类型放在 `src/core/<domain>/`；
3. 在 `src/host/services/index.ts` 的统一装配器注册服务域；
4. 需要新的官方服务时，在 `src/index.ts` 的 `inject` 中声明，并在 `package.json` 中补官方 SDK 类型依赖；
5. 路由、工具名、settings namespace 和持久化格式属于兼容契约，应在测试中固定。

服务域不是插件：它们共享 `web-all` 这一条 Cordis 生命周期。

## Browser 位置模块

先确定能力出现的位置，再接入唯一 owner：

- 侧栏和原生右栏：修改 `src/client/sidebar/index.ts` 的装配列表；
- 设置：修改 `src/client/index.ts` 的装配列表，所有设置槽注册的页面模块保留在 `src/client/settings/`；
- 会话：修改 `src/client/conversation/index.ts`；同一 slot 的多个 UI 条目在此统一安排 order。

组件 props 使用官方 `PropsRuntime<'slot.name'>`；未发布的槽声明可以在位置模块本地 augmentation，但应在官方 SDK 补齐后移除。浏览器 bundle 中 `@deepseek-ai/*` 只做 type-only 导入，跨模块协作走 Cordis service 或位置模块传入的 props。

## 社区代码

社区实现只作为行为和协议参考。重新实现时保留许可证和作者归属，不把旧插件入口、slot 注入器或包级生命周期复制到实体插件。无许可证或版权不明的代码不收编。

## 测试与真实运行时验证

实现后至少运行：

```sh
pnpm --filter @dsh-cove/dsh-web-all typecheck
pnpm --filter @dsh-cove/dsh-web-all test
pnpm --filter @dsh-cove/dsh-web-all build
pnpm runtime-deps:check
pnpm typecheck
pnpm test
pnpm test:scripts
pnpm docs:check
```

浏览器可见变更必须在现有托管 DSH GUI 中验证 host API、页面渲染、console/pageerror 和交互。不得重启正在运行的服务、占用 3080 端口或另起第二个 `dsh web`；若 host 变更需要重启，在交付中注明由用户重启后验证。

## 架构边界

- first-party 功能只作为 `dsh-web-all` 内部能力，不创建其他运行时实体；
- 每个注入位置只有一个 owner，能力文件不自行向其他位置注入；
- profile 只挂载 `@dsh-cove/dsh-web-all`，源/数据包不提供功能行；
- 不以占位卡、静态假数据或兼容转发代替真实能力实现。

## 发布清单

包、运行时能力或资产源布局变化时同步更新 `docs/publish-prep.md`。主插件 README 必须中英配对，更新后运行：

```sh
pnpm docs:write-pair packages/dsh-web-all
pnpm docs:check
```

长期架构事实写入 owning 文档；一次性验证证据放入对应 Issue 或 PR，发布历史保留在 GitHub Releases。
