# @dsh-cove/dsh-client-ui-community-plugins

[English](README.md) | 中文

社区插件索引数据源：`community.json` 是社区插件目录的唯一来源。条目只收录第三方插件作者自有仓库的链接与元数据；本仓库不搬运其代码。

## 功能

- 索引数据：`community.json` 由维护者审核合并；每条包含 `id` / `name` / `nameEn` / `author` / `repo`（必填）与 `description` / `descriptionEn` / `npm` / `category` / `subcategory`（可选；`subcategory` 为 `category` 下的二级分类，仅当 `category` 已填时有效，枚举见 `scripts/community-index`）。
- 校验：`node scripts/community-index` 对索引执行契约校验（CI 门禁 `pnpm community:check` 同款）。
- 运行时形态：本包是数据包，不提供运行时实体或设置界面。

## 安装

不要在 DSH profile 中挂载本包。消费方读取其导出的 `community.json` 数据。

## 配置

本包没有运行时配置；目录条目直接在 `community.json` 中维护。

## 已知限制

- 索引只收录链接，不校验第三方代码质量与安全；条目版权归原作者。
- 条目变更随包发布才对消费方生效；本仓库不生成目录页面，也没有对应部署。
