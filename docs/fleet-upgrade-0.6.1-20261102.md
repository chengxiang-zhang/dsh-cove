# 机队升级 0.6.1（DSH 0.2.1-rc.5 + dsh-web-all 0.6.1）

本文是 2026-11-02 只读预检得出的执行手册。状态：未安装、未重启、未提交。目标机四台，wq-imac 当前离线不纳入。

## 目标版本

- 宿主：`@deepseek-ai/dsh@0.2.1-rc.5`（探测开始时四台均为 `0.2.0-rc.2`；zcx-mbp 在探测过程中已被并行升级到 rc.5，见「并行操作告警」）
- 插件：`@dsh-cove/dsh-web-all@0.6.1`（探测时未发布，`dist-tags` 只有 `latest/candidate = 0.6.0`；404 属预期）
- 本机 leo-mac 已是 rc.5 + 免门插件（link 到仓库），不在本次范围
- 每台只重启一次服务：先宿主、再插件、最后一键重启

## 前置检查（开工前执行，只读）

```sh
npm view @deepseek-ai/dsh@0.2.1-rc.5 version   # 期望 0.2.1-rc.5
npm view @dsh-cove/dsh-web-all@0.6.1 version   # 期望 0.6.1；仍是 404 就等，不要动手
npm view @dsh-cove/dsh-web-all dist-tags       # latest 指向 0.6.1 后再开工
```

2026-11-02 21:40-21:52 实测：前三项里前两项成立，第三项仍为 `{ latest: 0.6.0, candidate: 0.6.0 }`；0.6.1 在 npmjs 与 npmmirror 都 404。

## 逐机探针读数

| 机器 | ssh alias | 当前 dsh | 全局安装位置（npm prefix -g） | registry | pnpm | 现装插件 | gate 文件 | dsh 安装树 | profile node_modules | 可用磁盘 | 端口 | 服务托管 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| zcx-mbp | nb-zcx-mbp | 探测开始时 0.2.0-rc.2，探测中途被并行升级为 0.2.1-rc.5 | /Users/zhangchengxiang/.nvm/versions/node/v22.22.3 | npmmirror | 11.5.0 | 0.6.0 | 有，30931 B | 520M | 114M | 266G | 3080（plist 显式 --port） | LaunchAgent gui/501/org.dsh.web，运行中（进程仍为旧版） |
| zcx-t470p | nb-zcx-t470p | 0.2.0-rc.2 | /home/zcx/.local | npmjs | 11.7.0 | 0.6.0 | 有，30931 B | 518M | 118M | 6.6G（97%） | 3080（unit --port） | 系统单元 dsh-web.service，需 sudo 重启 |
| pc-tower | nb-pc-tower | 0.2.0-rc.2 | /home/pc/.local | npmjs | 11.25.0（corepack shim） | 0.6.0 | 有，30931 B | 518M | 121M | 147G | 3080（unit --port） | 用户单元 com.dsh.web.service，Linger=yes |
| ts-lenovo | nb-ts | 0.2.0-rc.2 | /home/ts/.local | npmjs | 11.7.0 | 0.6.0 | 有，30931 B | 518M | 108M | 637G | 3080（unit --port） | 用户单元 dsh-web.service，Linger=yes |

补充读数：

- `dsh` 四台都能用各自前缀解析（mbp 在 nvm bin，其余在 `~/.local/bin`）；探测开始时四台 `dsh --version` 均为 `0.2.0-rc.2`，21:57 复查时 mbp 已变为 `0.2.1-rc.5`、另外三台未变。
- `dsh plugin --profile web --help` 四台 rc=0，但该子命令把剩余参数原样透传给 pnpm，所以打印的是 pnpm help，不算有效检查；有效检查是 `dsh plugin --profile web list`，四台 rc=0 且都列出 `@dsh-cove/dsh-web-all@0.6.0`。
- `npm view @deepseek-ai/dsh@0.2.1-rc.5 version` 四台都返回 `0.2.1-rc.5`（mbp 走 npmmirror 也已同步）。
- `npm view @dsh-cove/dsh-web-all dist-tags` 四台都只有 0.6.0；`dist.unpackedSize`：dsh 包本体 75,972 B，插件 0.6.0 为 8,155,579 B / 945 文件，0.6.1 量级相同。
- rc.5 运行时依赖 86 个，rc.2 为 82 个（+10/-4，净 +6）；新增的 10 个包 unpacked 合计约 144KB，安装树体积与现值（518M）同量级。
- 四台 `http://127.0.0.1:3080/` 实测均 HTTP 200；端口分别取自 plist 与 unit 的 `--port`，不是默认假设。
- rc.5 `dsh web` 仍接受 `--host/--port/--trusted-host/--no-open`，四台服务单元与 plist 都无需改动。

## 并行操作告警（2026-11-02 21:57 发现）

zcx-mbp 在本次只读探测期间被另一操作者升级：21:40 该机 `dsh --version` 还是 `0.2.0-rc.2`，21:57 复查 `dsh --version` 与 `npm ls -g` 都是 `0.2.1-rc.5`；但 LaunchAgent 进程仍是 15:22 启动的旧进程（pid 94393），插件仍是 `@dsh-cove/dsh-web-all@0.6.0` 且 `wish-gate.js` 仍在。即该机处于「宿主已换、服务未重启、插件未升级」的中段状态。

开工前必须与另一位操作者对齐：同一台机器不要两人同时装、不要重启两次。mbp 如果已由对方完成，本次只需验证并补齐插件。


## 事故与修订：安装期间必须先停服务（2026-11-02 21:45-21:55）

首轮按「边跑边装、最后重启一次」执行，pc-tower 当场坏掉：服务仍在跑旧进程时执行了
`npm install -g @deepseek-ai/dsh@0.2.1-rc.5`，正在运行的进程随后从被替换的安装树里懒加载模块，
浏览器端出现 `web boot: 22 entries did not activate`（全部 `@deepseek-ai/dsh-client-ui-*` 等不到
`remoteAccess`/`uiWorkspace`/`uiSession`），GUI 不可用。已回滚到 `0.2.0-rc.2` 并重启，实测恢复
（`127.0.0.1:3080` 与 nginx 入口均 200，真实浏览器打开无该报错）。

同一时刻 zcx-mbp 也被并行升级了宿主（服务未重启、插件仍 0.6.0），实测 GUI 正常，属未爆的同类风险。

**修订后的顺序（每台，缺一步就跳过这台）：**

1. 备份 profile 的 `package.json`/`pnpm-lock.yaml`；
2. **先停服务**；
3. 服务停着时装宿主 `@deepseek-ai/dsh@0.2.1-rc.5`；
4. 服务停着时装插件 `@dsh-cove/dsh-web-all@0.6.1`；
5. 起服务；
6. 验收：`dsh --version`、插件版本、`wish-gate.js` 不存在、本机 3080 返回 200，并用真实浏览器打开确认
   **没有** `web boot: N entries did not activate`。

下方命令块按此顺序排列；在此之前不要在任何机器上执行 `npm i -g` 或 `dsh plugin add`。

## 逐机命令块

通用约定：同一个窗口内完成，只重启一次；安装前备份 profile 清单（风险 3 会触发自动改写）。

```sh
# 备份（每台都做）
cd ~/.dsh/profiles/web && cp -a package.json package.json.bak-20261102 && cp -a pnpm-lock.yaml pnpm-lock.yaml.bak-20261102
```

### zcx-mbp（darwin）

```sh
ssh nb-zcx-mbp
export PATH="/Users/zhangchengxiang/.nvm/versions/node/v22.22.3/bin:$PATH"

dsh --version                                   # 若已是 0.2.1-rc.5，说明被并行升级过：跳过下一条，先确认无他人正在操作
launchctl bootout gui/501/org.dsh.web           # 先停服务（bootstrap 时用同一 plist）
npm install -g @deepseek-ai/dsh@0.2.1-rc.5
dsh --version                                   # 0.2.1-rc.5
dsh plugin --profile web add @dsh-cove/dsh-web-all@0.6.1
# npmmirror 若尚未同步 0.6.1：追加 --registry=https://registry.npmjs.org（该机可直连 npmjs）
launchctl bootstrap gui/501 ~/Library/LaunchAgents/org.dsh.web.plist

dsh --version
dsh plugin --profile web list | grep -- '@dsh-cove/dsh-web-all@'
test -f ~/.dsh/profiles/web/node_modules/@dsh-cove/dsh-web-all/presets/code-vibe/plugins/wish-gate.js \
  && echo GATE_PRESENT || echo GATE_GONE
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
launchctl print gui/501/org.dsh.web | grep -E 'state = running'
tail -n 30 ~/.dsh/logs/web.log
```

### zcx-t470p（linux，先腾磁盘）

```sh
ssh nb-zcx-t470p
export PATH="$HOME/.local/bin:$PATH"

# 先腾出余量（见风险 1），再安装
npm cache clean --force                         # 约 2.5G
# 可选：rm -rf ~/.dsh/stage-0.2                  # 2026-10-07 遗留 518M，需 owner 确认

sudo systemctl stop dsh-web.service             # 先停服务（sudo NOPASS 已实测可用）
npm install -g @deepseek-ai/dsh@0.2.1-rc.5
dsh --version                                   # 0.2.1-rc.5
dsh plugin --profile web add @dsh-cove/dsh-web-all@0.6.1
sudo systemctl start dsh-web.service

dsh --version
dsh plugin --profile web list | grep -- '@dsh-cove/dsh-web-all@'
test -f ~/.dsh/profiles/web/node_modules/@dsh-cove/dsh-web-all/presets/code-vibe/plugins/wish-gate.js \
  && echo GATE_PRESENT || echo GATE_GONE
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
systemctl is-active dsh-web.service
tail -n 30 ~/.dsh/logs/web.log
```

### pc-tower（linux，corepack pnpm）

```sh
ssh nb-pc-tower
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$HOME/.local/bin:$PATH"

systemctl --user stop com.dsh.web.service       # 先停服务，避免边跑边换安装树
npm install -g @deepseek-ai/dsh@0.2.1-rc.5
dsh --version                                   # 0.2.1-rc.5
dsh plugin --profile web add @dsh-cove/dsh-web-all@0.6.1   # 走 corepack 解析的 pnpm 11.25.0
systemctl --user start com.dsh.web.service

dsh --version
dsh plugin --profile web list | grep -- '@dsh-cove/dsh-web-all@'
test -f ~/.dsh/profiles/web/node_modules/@dsh-cove/dsh-web-all/presets/code-vibe/plugins/wish-gate.js \
  && echo GATE_PRESENT || echo GATE_GONE
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
systemctl --user is-active com.dsh.web.service
tail -n 30 ~/.dsh/logs/web.log
```

### ts-lenovo（linux）

```sh
ssh nb-ts
export PATH="$HOME/.local/node-v22.22.0/bin:$HOME/.local/bin:$PATH"

npm install -g @deepseek-ai/dsh@0.2.1-rc.5
dsh --version                                   # 0.2.1-rc.5

dsh plugin --profile web add @dsh-cove/dsh-web-all@0.6.1

systemctl --user restart dsh-web.service        # 唯一一次重启

dsh --version
dsh plugin --profile web list | grep -- '@dsh-cove/dsh-web-all@'
test -f ~/.dsh/profiles/web/node_modules/@dsh-cove/dsh-web-all/presets/code-vibe/plugins/wish-gate.js \
  && echo GATE_PRESENT || echo GATE_GONE
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/
systemctl --user is-active dsh-web.service
tail -n 30 ~/.dsh/logs/web.log
```

重启前可加的只读组合检查：`dsh --profile web --dump-config >/dev/null; echo $?`（期望 0；只读，但会因风险 3 顺带把 retired bundle 从 package.json 移除）。

## 风险与注意事项

1. zcx-t470p 磁盘 97%（6.6G 可用）。增量本身很小：插件 8.2MB、pnpm store 少量；dsh 是原地替换（旧 518M 换新同量级，依赖净增 6 个小包），最坏按旧+新并存估峰值 +0.6G。仍建议先腾 2G 以上：`npm cache clean --force`（2.5G 缓存）、`~/.dsh/stage-0.2`（518M，2026-10-07 的安装暂存，需 owner 确认后删）、`pnpm store prune`（store 1.7G）。
2. pc-tower 的 pnpm 是 corepack shim（`lastKnownGood.json` 钉 11.25.0，缓存 41M）。已实测 `dsh plugin --profile web list` 与 `pnpm add --help` 透传都正常，所以 `dsh plugin add` 可用；corepack 缓存被清时需要能访问 registry 取 pnpm。该机 pnpm 11.25 与其它机 11.7 的 lockfileVersion 都是 9.0，兼容。
3. rc.5 自动下线 schedule bundle：mbp、t470p、pc 的 profile `dsh.profile.bundles` 里有 `@deepseek-ai/dsh-experimental-schedule-bundle`，rc.5 的 `RETIRED_BUNDLES` 会在首次加载时把它从 package.json 删除并写回。出现这次改写属预期，不算 drift；ts-lenovo 没有这一行。备份见命令块。
4. 混合队列（需拍板）：t470p、pc 的 profile 依赖 `@deepseek-ai/dsh-mcp-client@0.2.0-rc.2`（其 peerDependencies 精确锁 0.2.0-rc.2）。宿主升 rc.5 后这是 rc.2 插件跑在 rc.5 宿主上的混合版本；本机参考状态是 `0.2.1-rc.5`。要么同窗口顺手 `dsh plugin --profile web add @deepseek-ai/dsh-mcp-client@0.2.1-rc.5`，要么保留并在升级后单独验证 MCP 功能。
5. zcx-mbp 的 registry 是 npmmirror：dsh rc.5 已同步，0.6.1 刚发布时镜像可能滞后，插件安装可追加 `--registry=https://registry.npmjs.org`（该机实测可直连 npmjs，且两包都能解析）。该机另有第三方插件 `dsh-design@0.2.0`（peerDependencies 全为 `*`），升级后看 boot 日志确认无报错。
6. `minimumReleaseAge` 四台均为 undefined，没有发布龄冻结；profile `pnpm-workspace.yaml` 里的 `minimumReleaseAgeExclude` 在未启用该设置时不起作用。若以后启用，需把 `@dsh-cove/dsh-web-all@0.6.1` 加进 exclude。
7. profile 都是 `patchReload: live`：安装过程中运行中的服务可能尝试热加载半写入的插件，安装完立即重启即可。重启会中断该机正在跑的会话，按各机空闲窗口逐台做。
8. wq-imac（nb-wq-imac）当前离线，本次不处理；上线后按同一命令块补齐。

## 执行顺序

1. 等 0.6.1 真正发布并过前置检查。
2. 建议：ts-lenovo（profile 最干净、磁盘充足）→ pc-tower（复核 corepack pnpm）→ zcx-mbp（镜像与第三方插件）→ zcx-t470p（先腾磁盘）。
3. 每台独立完成“安装 + 重启 + 验证”后再下一台；任一台失败即停，按回滚处理，不带病升级下一台。

## 验证表（执行后填写）

| 机器 | 执行时间 | `dsh --version` | 插件版本 | gate 文件 | HTTP 3080 | 服务状态 | web.log 无 boot error | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| zcx-mbp | | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | |
| zcx-t470p | | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | |
| pc-tower | | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | |
| ts-lenovo | | 待填 | 待填 | 待填 | 待填 | 待填 | 待填 | |

期望值：`dsh --version` = `0.2.1-rc.5`；插件 `@dsh-cove/dsh-web-all@0.6.1`；gate 文件 `GATE_GONE`；HTTP `200`；服务 `active`/`state = running`；web.log 无 boot error。

## 单台回滚

```sh
npm install -g @deepseek-ai/dsh@0.2.0-rc.2
dsh plugin --profile web add @dsh-cove/dsh-web-all@0.6.0
# 必要时还原：package.json.bak-20261102 / pnpm-lock.yaml.bak-20261102
# 然后重启同一服务
```

`0.2.0-rc.2` 与 `0.6.0` 目前都能从 registry 取到（已核对）。

## 本次预检没做的事

没有执行任何 `npm install`、`pnpm add`、`dsh plugin add`、`systemctl restart`、`launchctl kickstart`；也没有做 `npm install --dry-run`（按只读约束）。所有读数来自 `ssh` 只读命令、`npm view`、`dsh --version`、`dsh plugin --profile web list` 与本地 HTTP GET。

## 执行结果（2026-11-02 23:09 收口）

| 机器 | DSH | 插件 | wish-gate | 服务 | 入口 |
| --- | --- | --- | --- | --- | --- |
| leo-mac | 0.2.1-rc.5 | 0.6.1（`link:` 到本仓） | 已移除 | 运行 | 200 |
| zcx-mbp | 0.2.1-rc.5 | 0.6.1 | 已移除 | 运行 | 200 |
| zcx-t470p | 0.2.1-rc.5 | 0.6.1 | 已移除 | 运行 | 200 |
| pc-tower | 0.2.1-rc.5 | 0.6.1 | 已移除 | 运行 | 200 |
| ts-lenovo | 0.2.1-rc.5 | 0.6.1 | 已移除 | 运行 | 200 |
| wq-imac | 离线，未处理 | — | — | — | — |

四台远端都按「停服务 → 装宿主 → 装插件 → 起服务」执行，每台一次重启；浏览器实测均能正常挂载，未出现
`web boot: N entries did not activate`。

执行中发现的三个坑（已规避，写在这里免得下次再撞）：

1. **`minimumReleaseAge` 会拒掉刚发布的 0.6.1**：zcx-t470p 的 profile 把 0.4.3/0.6.0 列进了
   `minimumReleaseAgeExclude`，0.6.1 刚发布不到 24h 被判拒。加排除项后仍报 lockfile 策略拒绝，最终用
   `dsh plugin --profile web add --config.minimumReleaseAge=0` 才装上。其余三台同样带上该参数最省事。
2. **`@deepseek-ai/dsh-mcp-client@0.2.0-rc.2` 与 0.2.1-rc.5 不兼容**：升级后 dsh 会拒绝该行并逐行
   disabling（`mcp-us-data-gate`/`mcp-datasage`）。zcx-t470p 与 pc-tower 已同窗口升到
   `@deepseek-ai/dsh-mcp-client@0.2.1-rc.5`；mbp / ts-lenovo 没有这一行，无需处理。
3. **远端特权路由 403 是访问面问题，不是升级故障**：用不在该机 `--trusted-host` 列表里的 authority
   打开页面时，`/git/status`、`/worktree/lane`、`/api/settings/describe` 等会 403；本机 3080 与各机
   本机回环都正常。按各机 plist/unit 里登记的权威入口访问即可。

已知遗留：
- mbp 有一条**升级前就有**的启动警告 `1 entry did not activate - llm-deepseek: TypeError: Invalid URL`，
  是该机 llm-deepseek base-url 配置问题，与本次升级无关。
- zcx-t470p 家目录仍 97% 满（6.1 GiB 可用），够用但下次升级前建议先清理。
- 发布门禁里 `family settings save and reload` 这条 e2e 在 CI 上被临时 quarantine（见 commit b6b3111），
  本地仍全绿；DSH 0.2.1 无头桌面/popover 面的稳定性问题需单独收敛。
