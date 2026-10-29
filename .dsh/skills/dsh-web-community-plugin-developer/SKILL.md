---
name: dsh-web-community-plugin-developer
description: Develop a DSH community plugin and register it in the dsh-cove community plugin index — author the plugin in the contributor's own repository following the official cordis bundle standard, add its entry to packages/dsh-community-plugins/community.json, validate the index, and submit the PR. Use when the user asks to develop a community plugin (社区插件), register/index/接入 a community plugin into the dsh-cove index, or update community.json.
whenToUse: 用户要开发/新建一个社区插件、把第三方插件登记/接入社区插件索引、更新 community.json，或询问社区插件如何进入 dsh web GUI 的插件目录。不适用于：dsh-cove first-party 能力开发（直接进入 packages/dsh-web-all，遵循 packages/AGENTS.md）。
disable-model-invocation: true
---

# 社区插件开发者（dsh-cove 社区插件索引）

本技能覆盖两条路径：

- **路径 A**：社区贡献者在**自己的仓库**里开发一个 DSH 插件（官方 cordis bundle 标准）；
- **路径 B**：把插件**登记进 dsh-cove 的社区插件索引**（`packages/dsh-community-plugins/community.json`）。

## 0. 事实速览（先读）

- **只索引、不内嵌**：`packages/dsh-community-plugins`（npm `@dsh-cove/dsh-client-ui-community-plugins`）
  只登记条目，每个条目链到贡献者自己的仓库；本仓库**绝不打包第三方代码**。
- **展示形态**：本包是纯数据包，不注册独立设置页或 runtime row；仓库内不生成目录页面。
- **数据流**：`community.json` → `pnpm community:check` 校验 → 随包发布供消费方读取。
- **门禁**：`node scripts/community-index --check`（等价 `pnpm community:check`）是 CI 漂移门禁；
  `scripts/community-index.test.mjs` 在 `pnpm test:scripts` 里校验条目契约。

## 1. 路径 A：在自己的仓库开发社区插件

社区插件的实现完全在贡献者自己的仓库完成，dsh-cove 只链接它。按官方独立 bundle 标准实现，
本仓库侧的登记与命名要点见 `docs/plugins.md` 的「社区代码」与「发布清单」两节：

1. `package.json` 声明 `dsh.bundle.patch` → `cordis.patch.yml`，以及 `dsh.client`
   （`platform: "web"` + 浏览器半区注入列表）；
2. `cordis.patch.yml` — bundle patch 层（插入插件行的 id/name）；
3. `prepare` 脚本 = `tsdown`（git 安装后自动构建 `lib/`，自包含，无项目引用）；
4. host 半区 `src/index.ts`（`apply(ctx)`）、browser 半区 `src/client/`，分层与
   exports 约定同 packages/AGENTS.md；
5. 类型只来自 `@deepseek-ai/*` npm SDK devDependencies；browser 半区对 `@deepseek-ai/*`
   只能 type-only 导入（运行时由宿主 shell 的 module table 提供）。

可选：给插件接设置页（host 用 `installSettingsSection` 注册命名空间，browser 用
`ctx.settingsScope.bind` + `settings.plugins.tab` 槽），要点见
`docs/plugins.md`「Browser 位置模块」；发布到 npm 用自己的 scope（参考社区条目里的
`npm` 字段写法），用户即可 `dsh plugin add` 安装。

> First-party 能力不走社区索引：直接进入 `packages/dsh-web-all` 的对应位置或 host 服务域，不创建独立包。

## 2. 路径 B：登记进社区插件索引

1. 编辑 `packages/dsh-community-plugins/community.json`，追加一条记录。字段契约
   （`scripts/community-index` 强制校验，缺必填即抛错）：
   - 必填：`id`（唯一，小写 kebab）；`name` / `nameEn`（显示名，中/英）；`author`
     （贡献者 GitHub 用户或组织）；`repo`（`https://` 完整 URL，且只允许 path-safe
     字符 `^[A-Za-z0-9._~/-]+$`——消费者的安装命令会拼进 shell，空格与 shell
     元字符直接拒绝）；
   - 可选：`description` / `descriptionEn`（一句介绍，建议成对填写）；`npm`（npm 包名，
     **实际发布过才填**，且必须是合法包名）；`category`（`ui` / `agent` / `tools` /
     `knowledge` / `integration` / `security` / `utility` 之一，不在枚举即拒绝）；
     `subcategory`（`category` 下的二级分类，仅当 `category` 已填时有效）。
2. 校验索引：
   ```sh
   pnpm community:check
   pnpm --filter @dsh-cove/dsh-client-ui-community-plugins test
   ```
3. 本地验证：确认新条目在 `community.json` 中的位置符合预期（数组顺序即目录顺序）、`repo` 与 `npm` 链接可打开。
4. 提交 `community.json`，开 PR。条目由维护者在 `community.json` 里审核，PR 描述附插件名称、仓库链接与 npm 发布状态。

## 3. 验收清单（全部满足才算完成）

- [ ] 插件本体在贡献者自己的仓库，官方 bundle 标准四件套齐全
- [ ] community.json 条目字段契约全部满足（id 唯一、repo 为 path-safe 的 https:// URL、
       category 在枚举内、无 emoji）
- [ ] `pnpm community:check` 通过
- [ ] 社区索引包测试通过（guard 测试逐条校验条目）
- [ ] 新条目的仓库与 npm 链接可打开，安装命令可用
- [ ] PR 描述附插件名称、仓库链接与 npm 发布状态，提交信息无 emoji

## 4. 常见坑

- **repo 不是 path-safe 的 https:// URL**：校验直接拒绝（`must be an https:// URL of
  path-safe characters`；空格与 shell 元字符不允许）。
- **category 不在枚举内**：直接拒绝（`category must be one of ...`）。
- **把第三方代码提交进本仓库**：索引只登记元数据，任何第三方实现都应留在贡献者仓库。
- **npm 字段提前填**：包还没发布就填会误导用户安装失败；发布后再补。
- **中英 description 不成对**：索引面向中英双语用户，参考既有条目的成对写法。
- **以为本仓库会托管插件**：索引只是数据；插件运行起来靠贡献者仓库里自己的 cordis bundle。
