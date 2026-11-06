# 热更与重启

本仓改动的生效方式按"改了什么"分四类。判错这一档的代价是一次不必要的重启（会中断在线会话），所以每次交付都要先按本页判定，再决定是否要求用户重启。

## 三层热更各自管什么

| 层 | 机制 | 本仓的实际状态 |
| --- | --- | --- |
| 模块级 HMR | `@deepseek-ai/dsh-hmr` 监视 `root` 目录里的模块文件，改动即热替换 | 发行版 base 层把 `root` 设为 `[]`，**不监视任何目录**：本部署没有"改文件自动生效"这条路径 |
| Profile 重组 | `hmr.reconcileProfile()` 对比"已加载模块 vs 磁盘"，驱逐变更模块并重启对应 Loader 条目 | 唯一触发口是 Plugin Manager 的写操作（typert RPC） |
| 客户端资源 | `@deepseek-ai/dsh-client-hmr` 负责浏览器侧资源 | 只影响页面；宿主侧改动不需要它 |

`hmr.reconcileProfile()` 的比较范围是 `profileRoots`：profile 目录本身加上 profile `node_modules` 里每个符号链接指向的真实目录。本仓的 `@dsh-cove/dsh-web-all` 就是这样一个符号链接，所以**重建后的 `lib/` 在比较范围内**。

变更的模块能否被替换，由 `planReplacement` 判：模块在进程静态图里 → `host-module`；插件不由任何 Loader 条目启动 → `unmanaged-plugin`；两者都不命中 → 驱逐并重启该条目，即热替换。本仓的实体行 `web-all` 是 Loader 条目，工具与服务都注册在该条目内，因此不属于前两类。

## 判定表

| 改动 | 生效方式 |
| --- | --- |
| 预设散文与技能（`presets/code-vibe/**`） | `node scripts/render-preset.mjs` 后**新开会话**；预设按会话组合，改的是下一次组合的输入 |
| 客户端代码（`src/client/**` → `lib/client.js`） | 构建 + **刷新页面**：宿主按请求从磁盘读客户端 bundle，重建后服务端发出的 `&rev=` 内容哈希已变（2026-11-06 实测 `fcfd31d5586b` → `80167e2f45eb`），页面重新加载即拿到新代码 |
| 宿主代码（`src/host/**`、`src/core/**` → `lib/index.js`） | 构建 + 一次 profile 重组，**无需重启进程** |
| profile 配置（`~/.dsh/profiles/<name>/cordis.patch.yml`） | 一次 profile 重组；保存一次**合法**编辑会触发重组（实测 6 秒内生效），非法 YAML 不会 |
| DSH 自身包、或改进程静态图的模块 | 只能重启（重组会返回 `restart-required`） |

"一次 profile 重组"= 在 Plugin Manager 里做任意一次写操作（开关一个 bundle、安装/卸载），或向 profile 的 `cordis.patch.yml` 保存一次合法编辑。`dsh` CLI 没有重组子命令，也没有对应的 HTTP 路由；Plugin Manager 走 typert RPC，脚本侧用[`scripts/dev-reload.mjs`](../scripts/dev-reload.mjs)把「构建 + 一次重组 + 等生效」做成一条命令。

## 实测读数

| 结论 | 读数 |
| --- | --- |
| 当前进程挂着 HMR | `~/.dsh/logs/web.launchd.log` 里有 `dsh-hmr` 的 `runExclusive` 栈帧 |
| 只构建、不保存 profile | 2026-11-06 对照：改一处宿主字符串 `pnpm build` 后 20 秒内探测仍是旧值，进程 pid 不变 |
| 保存一次合法 patch 触发重组 | 同上再向 `cordis.patch.yml` 追加一行注释，6 秒内同一探测变为新值，进程 pid 不变 |
| 非法 YAML 的保存不触发 | 2026-11-06 实验：追加一段故意非法的 YAML，等待 10 秒，日志新增 **0 行**（连 `config reload ... failed` 都没有），随后从备份恢复并校验 sha256 一致 |
| 客户端 bundle 每次请求从磁盘读 | 同一天重建后，`curl /` 的 `@dsh-cove/dsh-web-all/client.js&rev=` 从 `fcfd31d5586b` 变为 `80167e2f45eb`，且取回的 bundle 已含新代码——说明客户端改动不需要重组，刷新页面即可 |
| 实体行化之后重组返回 `applied` | `docs/external-session.md` §13：同一 profile 连续两次 `set_bundle` 都回 `applied`，工具说明文字随之改变；挂预设平面的旧结构返回 `restart-required` + `unmanaged-plugin` |
| `patchReload` 在 0.2.1-rc.5 里无人读取 | 全包搜索命中 0，因此 profile manifest 里写 `patchReload: live` 不改变行为 |

两处需要分开看：仓库里研究的实现是 `0.2.1-rc.5`，而**本机在线服务跑的是 nvm 全局安装的 `0.2.0-rc.2`**（`/Users/leo/.nvm/versions/node/v22.22.0/lib/node_modules/@deepseek-ai/dsh`）。两版都有 `dsh-hmr` 与 `dsh-plugin-manager`，但行为差异只能各自实测，不能互相引用。

## 交付口径

1. 先按上表判断能否热应用；能热应用就写清"构建命令 + 重组步骤（或已经做过）+ 是否需要刷新页面"。
2. 只有判定表最后一档才写"需要用户重启 DSH 服务"，并给出理由（哪个模块、为什么在静态图里或不受 Loader 管理）。
3. 不允许把"客户端需要刷新页面"写成"需要重启"。
4. 不做无谓重启：重启会打断该机正在跑的会话，且历史上曾因误判造成长时间入口中断。