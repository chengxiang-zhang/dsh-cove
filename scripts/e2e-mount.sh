#!/usr/bin/env bash
# =============================================================================
# dsh-web-all 实体插件挂载冒烟编排（CI + 本地）：
#
#   1. `pnpm pack` 打出当前实体插件 tarball；
#   2. 用官方 CLI 把 tarball 真实挂载进一个全新 scratch profile
#      （`dsh plugin --profile web add file:<tarball>`，与用户安装路径一致）；
#   3. 启动真实 `dsh web`（keyless，--port 0 取 OS 分配端口）；
#   4. 运行 tests/e2e 无头渲染 lane（Playwright Chromium）。
#
# 用法：
#   bash scripts/e2e-mount.sh
#
# 环境变量（均可省略）：
#   DSH_CMD          一个可执行文件（可含空格的完整路径，不接受命令参数）；显式指定缺失即失败
#   WEB_PLUGIN_DIR   实体插件目录；缺省 packages/dsh-web-all
#   PORT             只允许 0（OS 分配，从日志解析 URL），拒绝固定端口
#   DSH_HOME_BASE    已存在的安全绝对父目录；其中 mkdtemp 新建私有子目录，绝不删除父目录
#   DSH_E2E_ROOT     可选的全新绝对 fixture 前缀；mkdtemp 附加随机后缀，输入本身不创建\n#                    已存在、symlink、危险或重叠路径拒绝
#                    缺省在 HOME 下 mkdtemp 新建独立私有子目录；输入目录不会被复用
#   KEEP_HOME        非空时保留 scratch home（调试用）
#
# 退出码 = playwright 的退出码；服务器与 scratch 目录由 trap 兜底清理。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

say()  { printf '\033[32m[e2e-mount]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[e2e-mount]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[e2e-mount]\033[0m %s\n' "$*" >&2; exit 1; }

# Resolve Node once: cleanup must not re-resolve a changed PATH.
NODE_BIN="$(command -v node)" || die "node is required"
[ -x "$NODE_BIN" ] || die "node must be an executable file"
readonly NODE_BIN
[ "${PORT-0}" = 0 ] || die "PORT must be 0 (an OS-assigned ephemeral port)"
PORT=0
WEB_PLUGIN_DIR="${WEB_PLUGIN_DIR:-$ROOT/packages/dsh-web-all}"
command -v pnpm >/dev/null 2>&1 || die "pnpm is required"

# Only this helper allocates/removes roots. Input parents are never cleanup
# targets. Cleanup checks the captured inode/owner receipt AND private sentinel.
owned_paths() {
  "$NODE_BIN" - "$@" <<'NODE'
const fs = require('node:fs'), p = require('node:path'), os = require('node:os');
const { randomBytes } = require('node:crypto');
const [mode, repo, ...receipts] = process.argv.slice(2);
const uid = process.getuid();
function fail(message) { throw new Error('e2e isolation: ' + message); }
function absolute(value) {
  if (!value || !p.isAbsolute(value) || /[\n\r\t]/.test(value) || p.normalize(value) !== value) fail('absolute normalized path required');
  return value;
}
function noLinks(value) {
  absolute(value);
  let current = p.parse(value).root;
  for (const part of value.slice(current.length).split(p.sep).filter(Boolean)) {
    current = p.join(current, part);
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink()) fail('symlink path refused: ' + current);
  }
  if (fs.realpathSync(value) !== value) fail('path identity changed');
  return fs.statSync(value);
}
function inside(parent, child) { const r = p.relative(parent, child); return r !== '' && !p.isAbsolute(r) && r !== '..' && !r.startsWith('..' + p.sep); }
function overlap(a, b) { return a === b || inside(a, b) || inside(b, a); }
const home = fs.realpathSync(absolute(process.env.HOME));
if (home === p.parse(home).root || !noLinks(home).isDirectory()) fail('HOME must identify a stable user directory');
const workspace = fs.realpathSync(repo);
function safeRoot(value) {
  absolute(value);
  if (value === p.parse(value).root || value === home || inside(value, home) || overlap(value, workspace)) fail('dangerous root/home/workspace path');
}
function checkReceipt(raw) {
  const saved = JSON.parse(raw), path = saved.path;
  safeRoot(path);
  const st = noLinks(path);
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o777) !== 0o700 || st.dev !== saved.dev || st.ino !== saved.ino || saved.uid !== uid) fail('owned directory identity changed');
  const marker = p.join(path, '.dsh-e2e-owner');
  const ms = fs.lstatSync(marker);
  if (!ms.isFile() || ms.isSymbolicLink() || ms.uid !== uid || (ms.mode & 0o777) !== 0o600 || ms.nlink !== 1 || fs.readFileSync(marker, 'utf8') !== raw) fail('owner sentinel changed');
  return path;
}
if (mode === 'cleanup') {
  // Validate ALL roots before deleting either; a replaced path preserves both.
  const paths = receipts.map(checkReceipt);
  if (paths.length !== 2 || overlap(paths[0], paths[1])) fail('cleanup roots overlap');
  for (const path of paths) { checkReceipt(receipts[paths.indexOf(path)]); fs.rmSync(path, { recursive: true, force: false }); }
} else if (mode === 'create') {
  const parent = process.env.DSH_HOME_BASE === undefined ? fs.realpathSync(os.tmpdir()) : absolute(process.env.DSH_HOME_BASE);
  safeRoot(parent);
  if (!noLinks(parent).isDirectory()) fail('scratch parent is not a directory');
  const desired = process.env.DSH_E2E_ROOT;
  let fixtureParent = home;
  if (desired !== undefined) {
    safeRoot(desired);
    let exists = true;
    try { fs.lstatSync(desired); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
    if (exists) fail('DSH_E2E_ROOT prefix must not exist');
    fixtureParent = p.dirname(desired);
    if (!noLinks(fixtureParent).isDirectory()) fail('fixture parent is not a directory');
    if (overlap(desired, parent)) fail('scratch parent and explicit fixture overlap');
  }
  const plugin = absolute(process.env.WEB_PLUGIN_DIR);
  if (!fs.statSync(p.join(plugin, 'package.json')).isFile()) fail('plugin package missing');
  let tarball = process.env.WEB_ALL_TARBALL || '';
  if (tarball) { absolute(tarball); if (!fs.statSync(tarball).isFile()) fail('tarball missing'); tarball = fs.realpathSync(tarball); }
  // All caller-controlled path checks precede allocation or CLI invocation.
  const token = randomBytes(32).toString('hex');
  const allocated = [];
  function allocate(prefix, kind) {
    const path = fs.mkdtempSync(prefix);
    fs.chmodSync(path, 0o700);
    const st = noLinks(path);
    const raw = JSON.stringify({ path, kind, token, uid, dev: st.dev, ino: st.ino });
    fs.writeFileSync(p.join(path, '.dsh-e2e-owner'), raw, { mode: 0o600, flag: 'wx' });
    allocated.push(raw);
    return path;
  }
  try {
    const scratch = allocate(p.join(parent, 'dsh-web-ui-e2e.'), 'scratch');
    const fixture = allocate(desired ? desired + '.' : p.join(fixtureParent, '.dsh-e2e-worktree.'), 'fixture');
    if (overlap(scratch, fixture)) fail('allocated roots overlap');
    console.log([scratch, fixture, ...allocated, tarball].join('\n'));
  } catch (error) {
    // A failed second allocation may still leave the first owned child. Never
    // remove a partially initialized directory without a valid ownership proof.
    for (const raw of allocated.reverse()) {
      try { fs.rmSync(checkReceipt(raw), { recursive: true, force: false }); }
      catch (cleanupError) { console.error('allocation cleanup refused:', cleanupError.message); }
    }
    throw error;
  }
} else fail('unknown operation');
NODE
}

# Preserve explicit wrappers: DSH_CMD is ONE executable, never shell text.
if [ "${DSH_CMD+x}" = x ]; then
  [ -n "$DSH_CMD" ] || die "DSH_CMD must name one executable"
  DSH_EXEC="$(command -v "$DSH_CMD")" || die "explicit DSH_CMD was not found"
  [ -f "$DSH_EXEC" ] && [ -x "$DSH_EXEC" ] || die "DSH_CMD must be an executable file"
  DSH_RUN=("$DSH_EXEC")
elif command -v dsh >/dev/null 2>&1; then
  DSH_RUN=("$(command -v dsh)")
else
  NPX_EXEC="$(command -v npx)" || die "neither dsh nor npx is available"
  DSH_RUN=("$NPX_EXEC" -y --package "@deepseek-ai/dsh@$("$NODE_BIN" "$ROOT/scripts/runtime-host-version.mjs")" dsh)
fi
export WEB_PLUGIN_DIR
ALLOCATION="$(owned_paths create "$ROOT")"
{
  IFS= read -r SCRATCH
  IFS= read -r E2E_ROOT
  IFS= read -r SCRATCH_RECEIPT
  IFS= read -r E2E_RECEIPT
  IFS= read -r VALIDATED_TARBALL || true
} <<< "$ALLOCATION"
readonly SCRATCH E2E_ROOT SCRATCH_RECEIPT E2E_RECEIPT
SERVER_PID=""
cleanup() {
  local code=$?
  trap - EXIT INT TERM HUP
  # Bash jobs, not a caller-provided PID, prove this is our own live child.
  if [ -n "$SERVER_PID" ] && jobs -pr | "$NODE_BIN" -e 'let s="";process.stdin.on("data",b=>s+=b).on("end",()=>process.exit(s.trim().split(/\s+/).includes(process.argv[1])?0:1))' "$SERVER_PID"; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -z "${KEEP_HOME:-}" ]; then
    if ! owned_paths cleanup "$ROOT" "$SCRATCH_RECEIPT" "$E2E_RECEIPT"; then
      warn "cleanup refused: owned root or sentinel changed; directories preserved"
      code=1
    fi
  else
    warn "KEEP_HOME set; preserving $SCRATCH and $E2E_ROOT"
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

export DSH_HOME="$SCRATCH/home"
WORKSPACE_DIR="$SCRATCH/workspace"
LOG_DIR="$SCRATCH"
WEB_LOG="$LOG_DIR/web.log"
HOST_VERSION="$("$NODE_BIN" "$ROOT/scripts/runtime-host-version.mjs")"
"$NODE_BIN" "$ROOT/scripts/runtime-host-version.mjs" --check "$("${DSH_RUN[@]}" --version)"
mkdir -p "$DSH_HOME/profiles/web" "$WORKSPACE_DIR"
say "scratch home: $DSH_HOME"

# 步骤 1：默认打包当前实体插件；发布验证可传入从 npm registry 下载的
# WEB_ALL_TARBALL，确保挂载的是已发布字节而不是 checkout-local pack。
if [ -n "${WEB_ALL_TARBALL:-}" ]; then
  TARBALL="$VALIDATED_TARBALL"
  [ -f "$TARBALL" ] || die "WEB_ALL_TARBALL 不存在：$TARBALL"
  say "使用外部实体插件 tarball: $TARBALL"
else
  say "打包实体插件：pnpm pack（${WEB_PLUGIN_DIR}）..."
  TARBALL="$(cd "$WEB_PLUGIN_DIR" && pnpm pack --silent 2>/dev/null | tail -1)"
  TARBALL="$(cd "$WEB_PLUGIN_DIR" && pwd)/$TARBALL"
  [ -f "$TARBALL" ] || die "pnpm pack 未产出 tarball（${WEB_PLUGIN_DIR}）"
  say "tarball: $TARBALL"
fi

# 步骤 2：引导 scratch profile（web 模板；先写 pnpm-workspace.yaml 的
# allowBuilds / minimumReleaseAgeExclude，避免 pnpm 11 strict-dep-builds
# 拦截 node-pty/protobufjs/cloudflared 或拒绝 <24h 新版本——同 install.sh）
PROFILE_DIR="$DSH_HOME/profiles/web"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
EOF
printf '[]\n' > "$PROFILE_DIR/cordis.patch.yml"
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

allowBuilds:
  node-pty: true
  protobufjs: true
  cloudflared: true
  cpu-features: true
  ssh2: true
  '@fugood/whisper.node': true

minimumReleaseAgeExclude:
  - '@dsh-cove/dsh-web-all'
EOF

# 步骤 3：官方 CLI 安装 tarball + bundle 协调（真实挂载路径）
say "执行 dsh plugin --profile web add file:$TARBALL ..."
"${DSH_RUN[@]}" plugin --profile web add "file:$TARBALL"

# 步骤 4：校验实体插件已注册到 dsh.profile.bundles。
if ! node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const bundles = p.dsh?.profile?.bundles ?? [];
  process.exit(bundles.some(b => b === "@dsh-cove/dsh-web-all") ? 0 : 1);
' "$PROFILE_DIR/package.json"; then
  warn "dsh-web-all 未出现在 dsh.profile.bundles 中——挂载未注册"
  cat "$PROFILE_DIR/package.json"
  exit 1
fi
say "挂载已注册：dsh.profile.bundles 包含 @dsh-cove/dsh-web-all"

# 步骤 5：预置 scratch profile 的工作区注册。
#
# 面板只列 workspaceRegistry 里已注册的工作区，scratch profile 默认只有非 git 的
# default-workspace：注册一个真实存在的目录，让浏览器 lane 面对的是正常外壳状态而不是
# 首次运行空态。（曾经的 worktree lane 需要这里再播一个 git 仓库与离线的 GitHub 替身，
# 那条 lane 已退役——见 .retired/ 下的说明。）
STORAGE_DIR="$DSH_HOME/storages"
WORKSPACE_ID="00000000-0000-4000-8000-0000000000e2"
mkdir -p "$STORAGE_DIR"
cat > "$STORAGE_DIR/workspace.json" <<EOF
{
  "unit": { "name": "workspace", "version": 2 },
  "global": {
    "initialized": true,
    "workspaceIds": ["$WORKSPACE_ID"],
    "archivedSessionIds": [],
    "pinnedSessionIds": []
  },
  "tables": {
    "workspaces": {
      "$WORKSPACE_ID": {
        "path": "$WORKSPACE_DIR",
        "title": "e2e-workspace",
        "sessionIds": [],
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z"
      }
    }
  }
}
EOF

# 步骤 6：启动 dsh web（--port 0 = OS 分配；keyless 可起）
#
# profile 是顶层选项：`dsh --profile web` 本身就是"用 web 这个 profile 起浏览器 UI"。
# 写成 `dsh web --profile web` 等于选了两次 profile，0.2.0-rc.2 实测直接报
# `option '--profile <name>' argument 'web' is invalid. select a profile only once`
# 并退出——服务没起来，冒烟永远失败。
say "启动 dsh web（port=${PORT}）..."
"${DSH_RUN[@]}" --profile web --host 127.0.0.1 --no-open --port 0 > "$WEB_LOG" 2>&1 &
SERVER_PID=$!

URL=""
for _ in $(seq 1 150); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "=== dsh web 提前退出，日志尾部 ===" >&2
    tail -30 "$WEB_LOG" >&2 || true
    exit 1
  fi
  # DSH 0.1.6 prints an authenticated URL (/?token=<launchToken>); keep the
  # full query so the Playwright lane passes the BrowserAuth gate.
  if URL="$(grep -oE 'dsh web: http://127\.0\.0\.1:[0-9]+/[^ )]*' "$WEB_LOG" | head -1 | awk '{print $3}')" && [ -n "$URL" ]; then
    break
  fi
  sleep 1
done
[ -n "$URL" ] || { echo "=== 150s 内未等到 dsh web 就绪，日志尾部 ===" >&2; tail -40 "$WEB_LOG" >&2 || true; exit 1; }
say "dsh web 就绪：${URL}（pid ${SERVER_PID}）"

# 步骤 7：运行无头渲染 lane（tests/e2e 下当前只有挂载+渲染这一条）
say "运行 Playwright 无头渲染 lane..."
# 这一步在 CI 上曾以「零输出」的方式失败：日志停在就绪那一行，看不出是浏览器被
# OOM 杀掉还是断言失败。退出码、runner 内存与浏览器版本都打出来，让下一位读者
# 一眼分清这两件事（137 = 被信号杀掉）。
if [ "$(uname -s)" = "Linux" ]; then
  free -m | sed 's/^/[e2e-mount] mem: /' || true
fi
pnpm exec playwright --version 2>/dev/null | sed 's/^/[e2e-mount] playwright /' || true
set +e
DSH_E2E_URL="$URL" DSH_E2E_WORKSPACE="$WORKSPACE_DIR" \
  pnpm exec playwright test
PLAYWRIGHT_STATUS=$?
set -e
say "Playwright 退出码：${PLAYWRIGHT_STATUS}"
if [ "$PLAYWRIGHT_STATUS" -ne 0 ]; then
  die "无头渲染 lane 失败（退出码 ${PLAYWRIGHT_STATUS}）；137 表示进程被信号杀掉（CI 上通常是内存不足）"
fi

say "通过：dsh-web-all 挂载到真实 DSH 后无头渲染未崩溃"
