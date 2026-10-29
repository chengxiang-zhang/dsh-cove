# dsh-cove 发布准备

## 发布范围

运行时只发布一个实体插件：

| 目录 | npm 包 | 形态 |
| --- | --- | --- |
| `packages/dsh-web-all` | `@dsh-cove/dsh-web-all` | 唯一 Cordis/runtime client 实体 |

发布版本由 tag 驱动：`vX.Y.Z` tag 是仓库唯一的版本号来源，每个一方 manifest（`packages/dsh-web-all`、`shared`、两个客户端）都声明它；`scripts/verify-version.mjs` 校验已发布包与 tag 一致，`scripts/version-doctrine.test.mjs` 校验全仓 manifest 一致。

## 运行时边界

Profile 的运行时 bundles 仅为 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 和 `@dsh-cove/dsh-web-all`；`web-ui-*` 子插件行与聚合依赖不进入 profile。

浏览器位置由 web-all 的 sidebar/settings/conversation 模块唯一注入；host 能力在同包服务域中注册。BrowserAuth 绕过默认关闭，只能通过 web-all 的 `noBrowserAuth` 配置显式启用。Playwright 服务域独占 `mcp__playwright__*`，部署前必须移除全局 `mcp-playwright` 条目。

## 资产与来源边界

第三方来源的许可证与作者归属继续随保留的资产或实体实现发布。

## 必须门禁

```sh
pnpm sync-shared:check
pnpm typecheck
pnpm test
pnpm test:scripts
pnpm runtime-deps:check
pnpm docs:check
pnpm build
```

发布工作流必须把 `@dsh-cove/dsh-web-all` 安装进全新的隔离 `DSH_HOME` 和独立 profile，以随机端口启动真实 `dsh web`；验证 host API、浏览器页面、位置入口、console/pageerror 和交互。宿主精确版本由 `scripts/runtime-host-version.mjs` 从运行时包的 `dsh.engines` 最低版本读取，CI、发布与本地 mount 共用该事实源。验证过程不得重启或占用受管的 3080 实例；日常 agent 会话不自行启动替代服务。mount 脚本只接受 `PORT=0`，以同一个显式 `web` profile 安装与启动，并且只清理自己创建、通过 realpath／inode／owner 标记核验的私有临时子目录；`DSH_HOME_BASE` 是现存安全父目录，`DSH_E2E_ROOT` 是必须不存在的绝对路径前缀，均不代表可递归删除的调用方目录。`DSH_CMD` 只能是单个可执行文件路径，有额外参数时应提供 exec wrapper，不能依赖 shell 字符串求值或静默 fallback。

发布顺序为：完整门禁与本地 pack 的真实挂载验证，通过后仅以 `candidate` dist-tag 发布同一 tarball；再下载精确版本的 registry tarball，核验 SHA512 完全一致并运行消费者挂载与浏览器 smoke，通过后才推进 `latest`。已存在版本不可覆盖：重跑时必须核验不可变 registry 字节与已门禁 tarball 一致，否则停止。发布工作流共用一个跨 tag 并发组，且推广前检查 registry 当前 `latest`；相同或更旧版本重跑不得使 `latest` 倒退。此约束不是 npm 的 compare-and-swap，仓库外的人工推广仍需协调；此流程只控制推广，不提供对 npm 发布的事务回滚。

npm 发布是按需开启的：`release.yml` 的 registry 路径（`candidate`、`verify-release`）只在仓库变量 `NPM_PUBLISH` 为 `true` 时运行，开启前必须先配好 npm Trusted Publisher 或 `NPM_TOKEN` secret，否则该路径只会停在认证失败。Trusted Publisher 需要同时具备 `npm publish` 与 `npm dist-tag` 两项权限：`npm trust github --allow-publish` 只授予前者，`npm dist-tag` 只能在 npmjs.com 的 Trusted Publisher 设置里勾选。缺这项时 candidate 仍然发布成功、registry 字节校验也照样跑，只有推进 `latest` 会被 403 拒绝；工作流不把这次拒绝判成发布失败，而是在 job summary 里给出唯一需要的后续动作 `pnpm release:promote vX.Y.Z`，由维护者用自己的 npm 登录执行一次 `npm dist-tag add` 并回读核对。无论是否发布到 npm，每个 tag 都由 `github-release` job 产出 GitHub Release，挂上已门禁的 tarball 与生成的发布说明；桌面端、Android 与 iOS 安装包由各自工作流挂到同一个 tag，因此 tag 的交付物不依赖 npm 账号。

## 发布检查

发布前确认：

- `packages/dsh-web-all/cordis.patch.yml` 只有 `web-all` 一行；
- package tarball 包含 `lib/index.js`、`lib/client.js` 和类型声明；
- 每个已发布 manifest 带 `repository`、`homepage`、`bugs`、`license` 与英文 `description`，npm 页面能指向本仓库；
- `pnpm-lock.yaml` 与 manifest 一致；
- 发布后 `npm view @dsh-cove/dsh-web-all dist-tags` 的 `latest` 与本次 tag 一致（CI 未能推进时用 `pnpm release:promote vX.Y.Z`）；
- README 中英配对 sidecar hash 当前有效，根 `README` 与 `CONTRIBUTING` 配对同样通过 `pnpm docs:check`；
- `SECURITY.md`、`NOTICE` 与各目录的第三方声明覆盖本次发布的全部资产；
- 未提交 token、私钥、测试 profile 或隔离运行目录。

发布只覆盖上表这一个包；其他 npm 身份只做 deprecate，不重新引入运行时依赖。
