# 机队采集与回流

本页是「把各台机器上的 DSH 改造收回来、合并进本仓、再分发出去」的唯一事实源。它回答三件事：采什么（范围）、多久采一次（定时）、采回来以后怎么进仓（合并与分发）。

## 为什么需要采集

`packages/dsh-web-all` 装到每台机器上是 npm 包，但机器上的实际改造大多发生在包外面：

| 位置 | 内容 | 是否随 npm 包升级 |
| --- | --- | --- |
| `$DSH_HOME/.agent-presets/<name>/` | 预设组合 `agent.cordis.yml`、skills、plugins、脚本、评测 | 否，机器本地 |
| `$DSH_HOME/profiles/<profile>/cordis.patch.yml` | 每台机器实际挂载的行（预设覆盖、模型、门禁） | 否 |
| `$DSH_HOME/profiles/<profile>/*.js` | 设备本地插件（例如 `local-plugin.js`） | 否 |
| `~/code/dsh-cove`、`~/code/dsh-web` | 机器自己的检出与未提交改动 | 否 |

机器上的改造不会自己回到仓库：一台机器改了预设，其他机器与本仓都看不到，除非有人去收。采集器把这几类「升级面」以只读方式取回本仓 `.harvest/`，评审合并后进 `packages/`，再通过 npm 版本分发回每台机器。

## 采集范围

范围由 `config/fleet-collect.local.json`（本机真实值，gitignore）声明，形状见提交在库的 `config/fleet-collect.example.json`。四类升级面：

1. **presets**：`.agent-presets/*/agent.cordis.yml`、`preset.yml`、`MAINTENANCE.md`、`skills/**`、`plugins/**`、`scripts/**`、`docs/**`、`evals/**`。这是预设本体，机器侧对预设的改造主要落在这一面。
2. **profiles**：`profiles/*/cordis.patch.yml` 与 profile 根目录的 `*.js` / `*.mjs` / `*.cjs`，即每台机器实际挂载了什么。
3. **skills**：`$DSH_HOME/skills` 下的部署级技能（不是包内技能）。
4. **checkouts**：`~/code` 下 `origin` 命中 `dsh-cove` / `dsh-web` 的 git 检出，取分支、HEAD、脏文件数与未提交 diff。

同时采集每台机器的判定信息：主机名、用户、系统、DSH home、每个 profile 安装的 `@dsh-cove/dsh-web-all` 版本。

**不采**（在远端就剪掉，一个字节都不传输）：`sessions/`、`storages/`、`backups/`、`node_modules/`、`.git/`、`__pycache__/`、`*.log`、`*.bak*`、`.env*`、`.credentials*`、`*.pem`、`*.key`、`*.api-key`、`*.sqlite*`、`evals/results-*`。采集面是「改造」，不是机器状态；其中几类还是密钥。

规模上限（`limits`，超出即该机器报错而不是悄悄截断）：单文件 2 MiB、单机总量 64 MiB、文件数 20000、SSH 超时 120 秒。

## 产物布局

```
.harvest/
  latest -> 20261102T121607/          # 最近一次
  20261102T121607/
    HARVEST.md                        # 人读：机器表 + 与仓库基线的预设漂移
    manifest.json                     # 机读：每台机器的探测结果、文件哈希、丢弃原因
    <machine>/
      machine.json? (在 manifest 内)   # 探测事实
      files/…                          # 采集到的原始树（保持 $DSH_HOME 相对路径）
      drift.json                       # 与 packages/dsh-web-all/presets/code-vibe 的差异
      checkouts.json                   # 该机器的检出与未提交 diff
```

`.harvest/` 落在仓库内但不入库：采集物里是未发布的 persona、门禁源码和机器路径，进公开仓库等于泄漏。它的价值在本机可用（`git status` 里的改动评审 + `diff -r`），不在历史里。

## 采集器

```
node scripts/dsh-fleet-collect.mjs                    # 全机队
node scripts/dsh-fleet-collect.mjs --only pc-tower    # 单机
node scripts/dsh-fleet-collect.mjs --dry-run          # 只探测与选面，不传文件
node scripts/dsh-fleet-collect.mjs --json             # stdout 只留一个 JSON 文档
node scripts/dsh-fleet-collect.mjs --scope <path>     # 换一份范围文件
```

只读契约：远端只跑 `find`、`du`、`git`、`tar -c`，不写、不改、不删。本地只跑 `tar -x`。每台机器的失败各自记录在 `manifest.json` 的 `error` 里，不中断其他机器；退出码 1 表示至少一台失败，2 表示范围文件或参数错误。

“选面”规则是「先按范围目录找候选，再按 include/exclude glob 过滤（相对该面根目录），最后按上限裁剪」；被裁掉的文件在 `dropped` 里带原因（`not-in-surface` / `file-count-cap` / `file-size-cap` / `total-size-cap`），所以上限咬掉时报告里看得见。

## 定时采集

macOS 上由 launchd 每天跑一次，plist 由采集器生成并在仓库内（`.harvest/fleet-collect.launchd.plist`），不写 `~/Library/LaunchAgents`：

```
node scripts/dsh-fleet-collect.mjs --print-schedule       # 打印要执行的安装命令
node scripts/dsh-fleet-collect.mjs --install-schedule     # 生成 plist 并 bootstrap
node scripts/dsh-fleet-collect.mjs --uninstall-schedule   # bootout
```

任务标签 `ai.deepseek.dsh.fleet-collect`，默认每天 09:15 跑 `--quiet`，输出落在 `.harvest/collect.log`、`.harvest/collect.err.log`。要改时间改 `renderSchedulePlist` 的入参（重新 `--install-schedule` 生效）。其他操作系统用 cron 调同一个命令即可，脚本本身不依赖 launchd。

安装动作要写 launchd 域或用户 crontab，超出了 DSH 文件沙箱的写域：在沙箱内的会话里 `--install-schedule` 会失败，此时脚本按 `--print-schedule` 的格式打印出可直接粘贴执行的命令（`launchctl bootstrap` 一行或 `crontab -` 一行），由操作者在沙箱外的终端执行一次。

## 从采集到合并

1. 读 `.harvest/latest/HARVEST.md`：机器表给出版本与漂移计数，“Preset drift against the repository baseline”逐机器列出 `+added / ~modified / -removed`。
2. 逐面评审：`diff -ru packages/dsh-web-all/presets/code-vibe .harvest/latest/<machine>/files/.agent-presets/code-vibe`。
3. 合并进库后，预设的**唯一真源是** `packages/dsh-web-all/presets/code-vibe/agent.cordis.yml`（组合）+ `preset.yml`（roster 文案）；`presets/code-vibe.patch.yml` 由 `node scripts/render-preset.mjs` 生成，不得手改。`pnpm preset:check` 同时守生成物与引用完整性（技能名/脚本路径/备份文件/frontmatter 与目录一致），并核对 `presets/superagent-desk.patch.yml` 与它自己的组合源；工具名规则会把预设自带的脚本（`*.sh` / `*.mjs`）也算进去，因为会写 `toolName:` 行的安装脚本正是这条规则存在的原因。
4. `pnpm typecheck && pnpm test && pnpm docs:check` 之后提交；`DSH_RUNTIME_VERIFY=1` 时 `preset-bundle.spec.ts` 会用真实 `dsh` 把整个组合挂起来，逐行报告 `fiberState`——这是“预设真的能装起来”的证据，而不仅是文本断言。

## 分发

分发只走包版本，不走手工拷贝：合并发版后，每台机器把 profile 里的 `@dsh-cove/dsh-web-all` 升到新版本并重启自己的 `dsh web`。

```
node scripts/dsh-fleet-rollout.mjs --version 0.6.0                        # 只出计划（默认）
node scripts/dsh-fleet-rollout.mjs --version 0.6.0 --apply --only pc-tower # 真装一台
```

计划阶段逐台打印要执行的 `dsh plugin --profile <p> add @dsh-cove/dsh-web-all@<ver>`、重启方式与要验证的入口地址，并顺手报告「当前装的是哪个版本、入口是否应答」——这就是分发前的机队基线。`dsh` 路径、`pnpm` 所在的 PATH 前缀、服务句柄（systemd user / systemd system / launchd label）都是逐台事实，按机器写在范围文件的 `dshPath`、`pathPrefix`、`service` 里；没有声明的机器才回落到现场探测，因为非交互 SSH 里既找不到 nvm 的 `dsh`，也常常找不到 `pnpm`。重启后入口会有一段 502，验证按轮询等到 200/302 才算通过。`--apply` 才真正安装与重启；重启会打断该机器上正在跑的会话，所以默认只出计划，且支持 `--only` 逐台灰度、`--skip-restart` 只装不重启。

判定标准是两条独立事实：磁盘上解析出的包版本等于目标版本，且入口返回 `200`/`302`。任一不成立即该机器失败，退出码 1。

## 已知边界

- 采集是**快照**，不是同步：它不会把本仓的改动推回机器，也不会解决机器之间的冲突，冲突由合并评审决定。
- 机器上 `profiles/*/cordis.patch.yml` 是各自部署的挂载层，通常包含机器特有的模型、端口、鉴权取值；采集它们是为了看清「谁挂了什么行」，不是要把它们并进包。
- 采集器不解析 YAML 语义，只做路径、版本与哈希层面的事实收集；语义差异必须靠 diff 评审。
