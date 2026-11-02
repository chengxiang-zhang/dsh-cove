# wish-gate v11 修复核验（2026-11-02）

> 核验基线：v10 对照 `b6194fd`（`git archive` 到 `/tmp` 运行），v11 代码 = 本地提交 `fix(preset): key the checkout claim on write destinations`（dev 分支，含 `git -C` delta 修复）+ 本文件。
> 环境：node v22.22.0 / pnpm 11.22.0。核验者只读，未改插件、测试、预设文案与生成物。
> 结论：**可以合入（ship）**。只读分析被误拒、以及镜像面（只读会话反占 checkout）两个方向都已修复；首轮核验发现的 `git -C` 过度纠正在本轮复验中确认修好；四处机械门全绿。剩余漏拦项属 ref 写（不改工作树文件），已列在 §7 残留风险。

## 1. 症状

用户会话：iOS 订阅首购折扣弹性实验（GrowthBook，三个实验），纯只读分析——查样本量、取数、算弹性，不写任何仓库文件。该会话与另一个正在使用同一 checkout 的会话并存时，多条分析命令被拒：

- `python3 - <<'PY'`（纯计算）、`... 2>&1`、`... 2>/dev/null`、`python3 analyze.py > /tmp/out.txt` 全部被判为"正在写这个 checkout"；
- 拒绝文案只有一条出口：**"默认走 lane —— 先 `scripts/dsh-lane.sh create …` 建 lane 再干"**；
- 该会话照做，去消费仓里找 `scripts/dsh-lane.sh`（不存在，脚本只在预设目录），于是反复尝试建 worktree lane，把一轮只读分析烧成施工动作。

同一机制的镜像面（同日发现）：只读会话先跑一条纯计算 heredoc，就会在 `<git-common-dir>/dsh-claims.jsonl` 里替自己记一条心跳，把**真正要写这个仓的会话**挡在门外 15 分钟。

## 2. 根因链

1. **词法判写**：`bashWrite` 正则把"命令形状像写"当作"正在写"——`> `、`tee`、`git apply`、`sed -i`、`python … <<'PY'` 任一命中即 `writeLike=true`。`2>&1`、`2>/dev/null`、heredoc 喂给解释器都属于这一类，但它们不产生任何文件。
2. **仓库根从 session cwd 反推**：bash 调用没有 `target` 参数，v10 写死 `start = sessCwd`，于是"这条命令像写"直接等于"它写的是会话 cwd 所在的仓"。实际上命令写的是 `/tmp`，或根本不写。
3. **拒绝文案单出口**：deny 文本无条件给出"默认走 lane"，没有"只读就把产物放到 /tmp"的更低代价出口。
4. **建议不可执行**：`scripts/dsh-lane.sh` 随预设分发（预设根 `scripts/`），消费仓通常没有该文件；文案给的是裸相对路径，agent 只能在实际仓库里空找。
5. **镜像面**：v10 在**其它门之前**刷新 claim，`writeLike` 一旦为真就落心跳，即使这条调用随后被路由门/ask 门拒绝。结果是只读会话可以合法地抢占 checkout，反向锁死真正干活的会话。

## 3. 修复（v11）

- **判据换成写目的地**：新增 `claimTargets` / `shellWriteDestinations` / 自带 shell tokenizer，只认显式目的地——`>` `>>` `>|` `&>` `&>>` 的重定向目标、`tee [-a]`、`sed -i`、`cp/mv/install/ln` 末位操作数、`mkdir/rm/rmdir/touch/truncate` 全部操作数、`dd of=`、`git` 写子命令（以 checkout 自身为目的地）。
- **只给写子命令登记 checkout**：`git` 分支先判子命令是否写，`if (!writes) return;` 之后才把 `-C/--git-dir` 目标（或 `.`）登记为目的地；`git -C <repo> log/status/diff` 这类读命令不再是目的地。
- **非目的地一律不算**：heredoc 正文整体剥离（`cat <<'EOF'` 里的 `>` 是数据不是重定向）；`2>&1`、`>&2`、`<`、`<<` 的操作数不记为写入；`/dev/null` 等 sink 跳过；含 `$`/反引号的不可解析目标不猜。
- **`cd` 参与解析**：`cd <dir> && echo x > f` 里 `f` 以新目录为基点；`( cd /tmp && … )` 同理。
- **无目的地 = 对 checkout 只读**：不 deny、不刷新 claim。claim 检查条件从 `writeLike` 放宽到 `writeLike || isBash`（否则 `cp a <repo>/b`、`git apply` 这类无重定向的真写会漏掉）。
- **refreshClaim 移到 pre-execute 链尾**：只有整条链放行的调用才落心跳，被后续门拒绝的调用不留 claim。
- **拒绝文案重写**：首句说明"这条调用会写 <dest>，属于 checkout <root>，另一会话（心跳 N 分钟前）在用"；随后按代价排序三条——① 只读任务把中间产物写 `/tmp` 或仓外后重试，纯只读不要建 lane；② 确实要改这个仓才建 lane，并给出**预设内脚本的绝对路径**且注明消费仓没有该脚本；③ 等它结束（15 分钟心跳过期）。全文不再出现"默认走 lane"。
- **合同测试**：`scripts/test-wish-gate.mjs` 增加中性临时 cwd（用例不再在测试仓里落 claim）+ 15 条 v11 用例（heredoc/`2>&1`/`2>/dev/null`/`> /tmp`/`git -C <repo> log` 放行且不落 claim；仓内重定向、`tee`、`sed -i`、`cp`、`mkdir`、`git -C <repo> apply`、`&>`/`&>>` 仍拒；`cd` 换基点；`git apply/merge/stash pop` 仍拒；被拒调用不落 claim；真写落且只落一条）。
- **预设文案**：`agent.cordis.yml` 的 PATHS 行把 lane 触发条件收紧为"同仓 2+ 个独立**写**任务并行"，写明脚本在预设目录、只读任务不占 lane、中间产物落 `/tmp`；生成物 `code-vibe.patch.yml` 由 `pnpm preset:render` 产出并与源同步；`skills/lane-worktree/SKILL.md` 增三条硬门 + 脚本解析三法（包内预设 / 用户级预置目录 / 拷到仓外）+ 排障行；`skills/task-router/SKILL.md` 增"只读不占 lane"与一条反模式。

## 4. 红转绿证据

### 4.1 单测（同一条命令，同机）

```
GATE=$PWD/packages/dsh-web-all/presets/code-vibe/plugins/wish-gate.js \
  node packages/dsh-web-all/presets/code-vibe/scripts/test-wish-gate.mjs
```

- 当前工作树（v11 + 本轮 delta）：`RESULT 68 pass, 4 fail`，共 72 条用例。
- HEAD（v10，用 `git archive HEAD` 解到 `/tmp` 的整份预设，从中性 cwd 运行）：`RESULT 53 pass, 4 fail`，共 57 条用例。
- 用例数 72 vs 57：v11 首轮新增 12 条，本轮 delta 新增 3 条（`git -C <claimed> log` 放行且不落 claim、`git -C <repo> apply` 仍拒、`&>` 与 `&>>` 计为文件目的地；见 `scripts/test-wish-gate.mjs:430-470`）。

4 条红是**既有失败**，首轮与本轮用例名逐条相同、且都属 ask 必要性判据（与 claim 无关）：

```
FAIL P1 ops authorization ask allowed
FAIL P1 worker subagent is never steered  steers=1
FAIL P1 second ask in the same user turn is denied
FAIL P1 ask allowed again after a new user message
```

### 4.2 Lead 复现驱动（`node /tmp/lane-repro/repro-claims.mjs`，session A 持 claim）

| 用例 | HEAD v10 | 当前 v11 |
|---|---|---|
| B `2>&1` | denied | allowed |
| B `2>/dev/null` | denied | allowed |
| B heredoc 纯计算 | denied | allowed |
| B `> /tmp/x` | denied | allowed |
| B `git status` | allowed | allowed |
| B 仓内写 | denied | denied（文案含 `/tmp` 出口、预设绝对路径、无"默认走 lane"） |

`claim file after B` 只有 `session-coderAAAA` 一条，只读会话没有落 claim。

### 4.3 镜像面（独立探针：只读会话先跑 heredoc，随后真实 coder 写）

```
HEAD v10   analysis heredoc -> allowed ; claims -> session-analysisBB ; coder write -> DENIED "默认走 lane …"
当前 v11   analysis heredoc -> allowed ; claims -> session-coderAAAA  ; coder write -> allowed
```

拒绝文案里的 lane 路径已核：`/Users/leo/code/dsh-web/packages/dsh-web-all/presets/code-vibe/scripts/dsh-lane.sh`，文件存在且可执行（13637 字节）。

### 4.4 本轮 delta 复验（首轮核验发现的 `git -C` 缺陷）

首轮在同一探针上看到：`git -C <已占用仓> log` 在 v11 DENIED、HEAD v10 ALLOWED，且 `git -C <未占用仓> log` 会替只读会话写 claim。本轮（修复后）同一探针：

```
git -C <claimed> log/status/diff                     -> ALLOWED
git --git-dir <claimed>/.git log                     -> ALLOWED
git -C <claimed> log > /tmp/x                        -> ALLOWED
git -C <claimed> log &> /tmp/x                       -> ALLOWED
git -C <claimed> apply/checkout/merge/stash pop/reset --hard/commit/tag/add/rm/mv -> DENIED
git -C <claimed> log &> <claimed>/out.txt            -> DENIED（真写仍拦）
只读 git -C <free repo> log                          -> ALLOWED，free 仓 claim 文件 (none)，其真实 coder 写入 allowed
claim 文件里只有 session-ownerAAAA（读会话未落 claim）
```

对照首轮（修复前，同一探针）：`git -C <claimed> log` DENIED；`git -C <free> log` 会落 `session-analysisCC` 的 claim 并锁死该仓 coder。

## 5. 对抗结果

### 5.1 试图把仓内写偷过解析器（B 会话 cwd = 被占仓，A 持有 claim）

被拒 14 / 23：

- 被正确拒绝：`printf x >> f`、`install x f`、`dd of=f`、`sed -i`、`cd <repo> && echo x > f`、`git -C <repo> apply`、带引号 `> "f"`、`> ./f`、`tee -a f`、`env FOO=1 echo x > f`、`sudo tee f`、`>| f`、`echo eA== | base64 -d > f`、`echo x &> f`。
- 漏过（真会写仓内，但解析器没归属）：`bash -c 'echo x > f'`、`sh -c 'echo x > f'`、`node -e "writeFileSync('f','x')"`、`python3 -c "open('f','w')"`、`eval 'echo x > f'`（写隐藏在解释器字符串里，§7 已声明接受）、`( cd /tmp ) ; echo x > f`（子 shell 的 `cd` 泄漏到后续命令，基点算错）、`curl -s -o f …`、`patch -p1 < fix.diff`、`find . -name a -exec touch f +`（命令自有输出参数未建模）。

`&>` / `&>>` 专项：B 在仓内时 `echo hi &> f`、`echo hi &>> f`、`echo hi &> ./f`、`echo hi &>f`、`cd <repo> && echo hi &> f`、`cd <repo> && git status &> f` 全部 DENIED；写到 `/tmp`、`/dev/null`、`>&2`、`2>&1`、`&> /tmp/x`、`&&` 链后跟 `&> /tmp/x` 全部 ALLOWED（无新增误拒）。

### 5.2 只读分析命令是否被误拒（29 条）

29 条全部放行：heredoc、`2>&1`、`2>/dev/null`、`> /dev/null 2>&1`、`> /tmp/x`、`tee /tmp`、`curl | jq`、`git status/log/diff/show/stash list/branch --contains`、`git -C <repo> log`、`grep -rn`、`sed -n '1,20p'`、`find`、`cat`、`jq < file`、`awk`、`wc`、`ls`、`ps | grep`、`pytest -q`、`node --version`、`cd /tmp && echo > f`、`mkdir /tmp`、`rm -f /tmp`、write 工具写 `/tmp`。

首轮唯一的 1 条误拒（`git -C <repo> log`）已消失。

### 5.3 git 读写分族（B 会话 cwd 在仓外，A 持有该仓 claim）

读族 13 条全部 ALLOWED：`log`、`status`、`diff --stat`、`--git-dir … log`、`show --stat`、`rev-parse`、`cat-file -p`、`branch --contains`、`stash list`、`worktree list`、`config --get`、`log > /tmp`、`log &> /tmp`。

写族：`apply`、`checkout -- .`、`merge`、`stash pop`、`reset --hard`、`commit`、`tag <name>`、`add .`、`rm`、`mv`、`log &> <repo>/out` 全部 DENIED（claim 门）；`branch -d/-D` 被破坏性门拒绝（需用户授权，不是 claim 门）。剩余 ref 写见 §7。

## 6. 首轮缺陷的修复闭环

首轮核验发现 `git -C` 目标在判断子命令是否写之前就被登记为目的地（当时 `plugins/wish-gate.js:356`），导致两类错误：读命令被误拒；读命令替只读会话抢占未占用仓。当时判定 needs-change。

本轮修复后（`plugins/wish-gate.js:358-370`）：

```js
358:  if (prog === 'git') {
359:    const sub = ops[0] || '';
360:    const subArgs = ops.slice(1);
361:    let writes = GIT_WRITE_SUBCOMMANDS.has(sub);
362:    if (sub === 'stash') writes = !['list', 'show'].includes(subArgs[0] || '');
363:    if (sub === 'branch') writes = subArgs.some((tok) => /^(-[dDmM]|--delete|--move|--set-upstream-to|-u)/.test(tok));
364:    if (sub === 'tag') writes = subArgs.length > 0;
365:    // A path-less working-tree mutation still owns the checkout it runs in. Only a
366:    // write registers its checkout: `git -C <repo> log` must stay read-only.
367:    if (!writes) return;
368:    if (repoDirs.length) { for (const dir of repoDirs) addDir(dir); return; }
369:    addDir('.');
370:    return;
```

两个方向都已消失（§4.4、§5.2、§5.3）：读命令放行且不落 claim；写子命令仍以 `-C` 目标或 cwd 为目的地被拦。首轮报告中的该阻断项关闭。

## 7. 残留风险（接受）

- **解释器字符串里的写入不归属**：`bash -c`、`sh -c`、`node -e`、`python3 -c`、`eval` 内的写入不产生目的地，claim 门看不见；`curl -o`、`patch`、`find -exec`、子 shell `cd` 泄漏同理。取舍是有意的：宁可漏拦（退回"人和会话自己避让"），也不要再把只读命令误拒。
- **git ref 写未归属（本轮新确认，不改工作树文件）**：`subArgs` 只含非 `-` 开头的 token（`plugins/wish-gate.js:352-355` 把所有 `-x` / `--long` 丢弃），所以 `plugins/wish-gate.js:363` 的 branch 标志判断拿不到任何标志，实际是死代码。实测在另一会话持有 claim 时仍放行：`git branch -m a b`、`git branch -u origin/dev`、`git branch --delete old`、`git branch newbr`、`git fetch`。其中 `git branch -d/-D` 仍会被破坏性门拦下（需授权），但长写 `--delete` 两门都不覆盖。这些都是 ref 层面的引用写，不改工作树文件，所以"两个会话不要抢同一个工作树（文件）"的承诺仍然成立；若要把 branch 标志判断变活，修法是在 `352-355` 行把标志另行收集（而非丢弃），让 `363` 行查这份标志。
- **claim 是 advisory heartbeat，不是锁**：15 分钟 TTL、30 秒续约阈值、只读不续约。两个会话在同一时刻读到"无他人心跳"仍可同时通过；它降低冲突概率，不保证互斥。
- **只覆盖同一台机器的同一个 git common dir**：跨机、跨 checkout 副本没有共享注册表。
- **验收口径**：本次核验是机械门与单元/复现层，不是真实 DSH 双会话 GUI 演练；文案是否被模型正确执行需部署后观察。

## 8. 部署注意

预设是**打包产物**：`packages/dsh-web-all/presets/code-vibe/**` 的改动要先生成/部署预设 bundle，再由**用户自行重启 DSH 服务**才对运行中的会话生效；在那之前，线上仍在跑 v10 逻辑与旧文案。

- 不要由 agent 重启或杀掉 `dsh web` 及其宿主进程。
- 交付时应在报告里明确标注"需要用户重启 DSH 服务后生效"，由用户自行重启验证。

## 9. 门禁与核验命令（本轮实跑）

| 命令 | 结果 |
|---|---|
| 合同套件（GATE=工作树插件） | `RESULT 68 pass, 4 fail`（4 红为既有 ask 用例，见 §4.1） |
| `pnpm preset:check` | `render-preset OK` / `verify-preset-refs OK (32 skills, loader patch in sync)` |
| `node --test scripts/verify-preset-refs.test.mjs` | 9 tests, 9 pass, 0 fail |
| `pnpm docs:check` | `verify-docs: all documentation gates passed` |
| `pnpm test:scripts` | 495 pass, 0 fail |

工作区状态：v11 代码已提交到本地 `dev`（`fix(preset): key the checkout claim on write destinations`），提交内容与本次核验的字节一致（`git show <commit>:<path> | cmp - <path>` 无差异）；本报告随同一提交入库。仓库内无 `.git/dsh-claims.jsonl`（v11 测试用中性临时 cwd，不再在测试仓落 claim）。

## 10. 后续处置：门已移除（2026-11-02，owner 决定）

本报告核验的 v11 是这条机械门的最后一版。核验结论「可以合入」只针对 v11 相对 v10 的两个缺陷修复，不构成「这条门值得继续存在」的结论；随后 owner 决定把 `wish-gate` 从 bundled `code-vibe` 预设整体移除，理由四条：

1. **只读命令被误拒**：`git -C <repo> log`、纯计算 heredoc 等本不落盘的调用仍被判为写本仓（本轮修掉的只是其中一类）；
2. **镜像面锁死**：只读会话替自己记下工作树心跳，反过来把真正要写这个仓的会话挡在门外 15 分钟；
3. **状态文件落在别人的仓里**：`dsh-claims.jsonl` 写在 `<git-common-dir>` 下，等于往用户仓库的 `.git` 里写私有状态；
4. **门自身没有可信的绿**：合同套件在 HEAD 上就是红的（§9 的 4 条 ask 用例），一份红着的门无法作为合入判据。

移除后留下的是纪律与便利工具，不是机械门：`skills/lane-worktree/SKILL.md`（一任务一 lane、登记、合并预演、清理）与 `scripts/dsh-lane.sh`（含 `audit`）继续随预设分发；跨会话占用避让回到「会话自己看工作树（`git status`/`git log`/`dsh-lane list`）」，**没有机械占用门**。插件、合同测试与挂载行同批删除，维护记录见 `MAINTENANCE.md` 的「wish-gate 已移除（2026-11-02）」。
