// wish-gate v11: NECESSITY-ONLY confirmation + routing + cross-session checkout gates.
//
// v9 fixes the six mechanical defects found in the 2026-10-27..11-01 sessions
// (see docs/GATE-FIX-REPORT-20261101.md):
//   P0-1 only a real user message sets the request; subagent reports, memory and
//        time-context injections are stored separately and never authorize anything.
//   P0-2 routing gates apply to write/exec tools only — team coordination tools
//        (send_message / wait_agent / job_* / todo_write / team_task_*) never block.
//   P0-3 worker subagents are not the user's counterparty: no ask-user gates and no
//        routing inside a delegation; they keep only safety gates (worktree /
//        destructive / commit) and must report to the Lead instead of freezing.
//   P0-4 every skill named by a gate must exist (the old ledger rule pointed at a
//        missing skill).
//   P0-5 destructive shell commands require explicit authorization; isolated test
//        beds (crush/preview//tmp//.build-cache) stay open so benchmark loops do not stall.
//   P0-6 commit authorization is recognized from the user's own words, including
//        "搞定/收尾", and persists for the session.
//   v10 also claims the working tree per session (`<git-common-dir>/dsh-claims.jsonl`,
//   15 min heartbeat) and redirects a second live session to a lane instead of
//   letting two sessions fight over one checkout.
//   v11 keys that claim on the paths a call actually writes (write/edit arguments,
//        explicit bash destinations) instead of the lexical `bashWrite` shape: a
//        read-only analysis session was denied — and pushed into creating a lane —
//        just for running `python3 - <<'PY'` or `... > /tmp/x` inside a checkout
//        another session held. No destination means no claim and no deny.
//
// Ask the user ONLY when the agent cannot safely proceed without their input:
//   A. authorization / irreversible ops (production, switch, rebuild, delete)
//   B. missing fact that cannot be discovered in the workspace
//   C. genuinely vague product wish (taste words, no object/field/acceptance)
//   D. detected conflict/replay where continuing would write wrong state

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch']);
const DELEGATE_TOOLS = new Set(['subagent', 'subagent_fork', 'spawn_teammate', 'workflow']);
const GATED_TOOLS = new Set([...WRITE_TOOLS, ...DELEGATE_TOOLS]);

const OPS_RE = /(生产|上线|发布|切到|切换|回滚|重建|删除|drop|truncate|迁移|migration|nginx|staging|k8s|docker compose|部署)/i;
const VAGUE_RE = /(好看|丑|美化|优化一下|看着办|随便|更专业|提升.*(体验|质感|档次)|你定|帮我想|不知道)/;
const CONCRETE_RE = /(添加|加一个|增加|支持|筛选|下拉|按钮|弹窗|表单校验|排序|分页|导出|接口\s*(名|路径)?|\/[\w.-]+\.(html|css|js|vue|tsx?)|status|filter)/i;
const MISSING_FACT_RE = /(新版|旧版|上次说的|那个版本|某台|线上|多少个|多少条|QPS|哪个环境|哪台机器)/;
const CONFLICT_RE = /(冲突|重播|已经存在|不一致|漂移)/;
const T3WISH_RE = /(改版|重做|重设计|换皮|整站|4\s*个页面|四个页面|多页|全面改)/;
const DESIGN_DOMAIN_SKILLS = new Set([
  'business-design', 'product-design', 'information-architecture', 'interaction-visual-design',
  'ux-research', 'architecture-design', 'tech-design', 'tech-selection',
]);
const REVIEW_RE = /(评审|reviewer|审稿|复核|review\b)/i;

const DATA_RE = /(加一列|回填|migration|migrate|迁移|schema|DDL|ddl|表结构|索引|建表|数据变更)/;
const CONTRACT_RE = /(契约|contract|同步改|跨仓)/i;
const MULTI_RE = /(拆成|拆成三|多文件|跨模块|两个仓|三个文件|四个文件|分三个文件)/;
const REVAMP_RE = /(改版|换皮|整站|重做页面|重新设计页面|重设计页面)/;
const T3_RE = /(\bgap\b|清单|backlog|账本|开环|收掉|批次|派工|\bworker\b)/i;
const COMMIT_RE = /(提交|commit|push|合入|入库)/i;
// P0-6: "搞定/收尾/首尾" already means "take it to done" and includes the commit.
const COMMIT_AUTH_RE = /(提交|commit|push|合入|入库|收尾|搞定|首尾|交付|做完)/i;
const FIX_RE = /(修绿|修好|修一下|修复|\bbug\b|flaky|失败测试|错字|拼写|typo|test_[A-Za-z0-9_]+.*(绿|过))/i;
const RESEARCH_RE = /(调研|研究|对比|比较|评估|分析|梳理|审计|findings|写个报告|出个报告)/i;
const INCIDENT_RE = /(事故|故障|报警|宕机|挂了|incident|止血)/i;
const LEDGER_RE = /(假完成|算完成|完成了吗|宣布完成|直接完成|done 了|验收账本|关条|construction done)/i;
const MEASURE_RE = /(压测|容量|benchmark|基准测试|吞吐|延迟|p99|最优配置|最优规格|资源配比|扩节点|EPS|QPS|单节点.*(配置|规格))/i;
const DESIGN_RE = /(架构设计|架构重构|架构方案|架构评审|技术选型|选型|业务设计|业务流程|产品设计|信息架构|交互设计|视觉设计|设计方案|设计稿|重设计|重构方案|ADR)/i;
const WISH_ROUTE_RE = /(界面|页面|样式|视觉|空态|空状态|列表页|表单|前端|UI|改版|换皮)/;

// P0-5: destructive shell surface. Isolated test beds are explicitly exempted so
// benchmark / preview loops (lakeweaver-crush, *-preview, /tmp, .build-cache) keep running.
const DESTRUCTIVE_RE = new RegExp([
  String.raw`\bkubectl\b[^\n]*\b(delete|scale|drain|cordon|rollout\s+undo|replace\s+--force)\b`,
  String.raw`\bhelm\b[^\n]*\b(uninstall|delete|rollback)\b`,
  String.raw`\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\b`,
  String.raw`\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+(-f|--force|--)|restore\b|branch\s+-D|push\s+(-f|--force)|stash\s+(drop|clear))`,
  String.raw`\bdocker\b[^\n]*\b(rm|rmi|system\s+prune)\b`,
  String.raw`\b(drop\s+(database|table|schema)|truncate\s+table)\b`,
  String.raw`\b(mkfs|dd\s+if=)`,
  String.raw`\bfind\b[^\n]*-delete\b`,
].join('|'), 'i');
const SAFE_BED_RE = /(lakeweaver-crush|crush|preview|sandbox|bench)/i;
const PROD_RE = /(staging|prod|production|生产|客户)/i;
const SAFE_PATH_RE = /(\/tmp\/|\.tmp\/|\.build-cache\/|\.trash\/)/;
const AUTHORIZE_RE = /(批准|授权|同意|放行|开跑|按这个|就按|照这个|按我说的|删掉吧|干掉|清掉|下线|关掉|执行吧|动手吧|开始执行|允许)/;
// "不用提交/别删" is not an authorization; a negated phrase must never open a gate.
const INSTRUCTION_DELETE_RE = /(删掉|删除|清掉|干掉|销毁|重置|回滚到|下线)/;
const NEGATED_RE = /(不用|不要|别|无需|不必|不需要|先不|暂不)\s*[^。；\n]{0,12}(提交|commit|push|合入|删|批准|授权|执行|干掉|清掉)/i;
const APPROVAL_ANSWER_RE = /(批准|授权|同意|可以|放行|按这个|就按|删吧|删掉|执行|ok|yes)/i;

const ROUTING_RULES = [
  { re: DESIGN_RE, need: ['design-orchestrator'], msg: '设计类（架构/产品/选型/IA/交互）：先加载 `design-orchestrator` 判层、列件、定评审' },
  { re: WISH_ROUTE_RE, need: ['wish-programming'], msg: 'UI/产品改动：先加载 `wish-programming` 再写（具体需求不用问）' },
  { re: MEASURE_RE, need: ['measurement-evidence'], msg: '容量/压测/规格：先加载 `measurement-evidence`（重复性/环境健康/持续 vs 突发/守恒/对抗组）' },
  { re: FIX_RE, need: ['fix-loop'], msg: 'T1 修复：先加载 `fix-loop`（跑红→修→跑绿→负控）' },
  { re: RESEARCH_RE, need: ['research-brief'], msg: '调研/审计：先加载 `research-brief` 再产出 findings' },
  { re: INCIDENT_RE, need: ['incident-runbook'], msg: '事故：先加载 `incident-runbook`（先止血）' },
  { re: LEDGER_RE, need: ['ledger-close-not-construction-done'], msg: '完成/关条判定：先加载 `ledger-close-not-construction-done`' },
  { re: DATA_RE, need: ['change-spec'], msg: '数据/迁移类 T2：先加载 `change-spec` 再写文件' },
  { re: OPS_RE, need: ['change-spec'], msg: '运维/生产类 T2：先加载 `change-spec`（并等授权）' },
  { re: CONTRACT_RE, need: ['change-spec'], msg: '跨仓契约类 T2：先加载 `change-spec`' },
  { re: MULTI_RE, need: ['change-spec', 'large-backlog-program'], msg: '多文件/跨模块改动：先加载 `change-spec`（或 program）' },
  { re: REVAMP_RE, need: ['wish-programming'], msg: '大改版：先加载 `wish-programming`（产品门）' },
];

const parse = (a) => { if (typeof a === 'string') { try { return JSON.parse(a); } catch { return {}; } } return a || {}; };

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && typeof c === 'object' && c.type === 'text').map((c) => c.text || '').join('\n');
};
const resultText = (exec) => {
  const r = exec && (exec.result ?? exec.output ?? exec.value);
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (Array.isArray(r.content)) return textOf(r.content);
  try { return JSON.stringify(r); } catch { return ''; }
};
// Cross-session checkout ownership: a session that writes into a repo claims that
// working tree in `<git-common-dir>/dsh-claims.jsonl` (heartbeat, not a lock). A
// second live session in the same tree is redirected to a lane instead of silently
// fighting over one checkout — the 2026-10-31 14:00 conflict, made mechanical.
const CLAIM_TTL_MS = 15 * 60 * 1000;
const CLAIM_REFRESH_MS = 30 * 1000;
const nearestRepoRoot = (start) => {
  let dir = path.resolve(start || process.cwd());
  for (let i = 0; i < 12; i++) {
    try { if (fs.existsSync(path.join(dir, '.git'))) return dir; } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};
const claimsFileFor = (root) => {
  const git = path.join(root, '.git');
  try {
    if (fs.statSync(git).isDirectory()) return path.join(git, 'dsh-claims.jsonl');
    const m = fs.readFileSync(git, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (m) {
      const gitdir = path.resolve(root, m[1].trim());
      // Worktrees keep a private gitdir; the shared registry lives in the common dir
      // (`<gitdir>/commondir` points at it, usually `../..`).
      try {
        const common = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
        if (common) return path.join(path.resolve(gitdir, common), 'dsh-claims.jsonl');
      } catch {}
      return path.join(gitdir, 'dsh-claims.jsonl');
    }
  } catch {}
  return path.join(git, 'dsh-claims.jsonl');
};
const readClaims = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((c) => c && typeof c === 'object');
  } catch { return []; }
};
const otherLiveClaim = (file, root, selfId, now) => readClaims(file)
  .filter((c) => c.root === root && c.sessionId !== selfId && now - Number(c.ts || 0) < CLAIM_TTL_MS)
  .sort((a, b) => Number(b.ts) - Number(a.ts))[0];
const refreshClaim = (file, root, selfId, now) => {
  const all = readClaims(file).filter((c) => now - Number(c.ts || 0) < CLAIM_TTL_MS);
  const mine = all.find((c) => c.root === root && c.sessionId === selfId);
  if (mine && now - Number(mine.ts) < CLAIM_REFRESH_MS) return;
  const next = all.filter((c) => !(c.root === root && c.sessionId === selfId));
  next.push({ root, sessionId: selfId, pid: process.pid, ts: now });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next.slice(-200).map((c) => JSON.stringify(c)).join('\n') + '\n');
  } catch {}
};

// Write destinations: the claim gate needs "which paths does this call write", not
// "does this command look like a write". Only explicit destinations count — a
// heredoc into python/node/sh is program input, not an output file.
// File-writing redirections. `&>`/`&>>` (both streams to a file) name a real
// destination; only `2>&1`-style fd duplication is destination-free.
const SHELL_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>']);
const SHELL_FD_PREFIXABLE = new Set(['>', '>>', '>|']);
const SHELL_BLACKHOLE = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;
const SHELL_PREFIX = new Set(['sudo', 'env', 'time', 'nohup', 'command', 'builtin', 'exec']);
const SHELL_ALL_OPERANDS = new Set(['mkdir', 'rm', 'rmdir', 'touch', 'truncate']);
const SHELL_LAST_OPERAND = new Set(['cp', 'mv', 'install', 'ln']);
const SHELL_FLAG_VALUES = {
  sed: new Set(['-e', '-f', '--expression', '--file']),
  truncate: new Set(['-s', '--size', '-r', '--reference']),
  touch: new Set(['-d', '--date', '-r', '--reference', '-t', '--time']),
  mkdir: new Set(['-m', '--mode']),
  install: new Set(['-m', '--mode', '-o', '--owner', '-g', '--group', '-t', '--target-directory']),
  cp: new Set(['-t', '--target-directory']),
  mv: new Set(['-t', '--target-directory']),
  ln: new Set(['-t', '--target-directory']),
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']),
};
const SHELL_SCRIPT_FLAGS = new Set(['-e', '-f', '--expression', '--file']);
const SHELL_TARGET_FLAGS = new Set(['-t', '--target-directory']);
const GIT_REPO_FLAGS = new Set(['-C', '--git-dir', '--work-tree']);
// `git` subcommands that mutate the working tree / index / refs. They name no path,
// so the checkout itself is the destination: two sessions must not share a tree.
const GIT_WRITE_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv',
  'pull', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch',
]);

// Drop heredoc bodies: `cat <<'EOF' ... EOF` is input, and its body may contain any
// literal text (including `>`), so it must never be parsed for destinations.
const stripHeredocBodies = (cmd) => {
  const lines = String(cmd).split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    kept.push(line);
    const terms = [];
    const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
    let m;
    while ((m = re.exec(line))) terms.push(m[2]);
    for (const term of terms) {
      i += 1;
      while (i < lines.length && lines[i].replace(/^\t+/, '').trim() !== term) i += 1;
    }
  }
  return kept.join('\n');
};

const tokenizeShell = (cmd) => {
  const toks = [];
  const n = cmd.length;
  let i = 0;
  const push = (t, v, s, e) => toks.push({ t, v, s, e });
  while (i < n) {
    const c = cmd[i];
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; continue; }
    if (c === '\n' || c === ';' || c === '(' || c === ')') { push('sep', c, i, i + 1); i += 1; continue; }
    if (c === '`') { i += 1; continue; }
    if (c === '|') {
      const two = cmd[i + 1] === '|';
      push('sep', two ? '||' : '|', i, i + (two ? 2 : 1));
      i += two ? 2 : 1;
      continue;
    }
    if (c === '&') {
      if (cmd[i + 1] === '&') { push('sep', '&&', i, i + 2); i += 2; continue; }
      if (cmd[i + 1] === '>') {
        const two = cmd[i + 2] === '>';
        push('redir', two ? '&>>' : '&>', i, i + (two ? 3 : 2));
        i += two ? 3 : 2;
        continue;
      }
      push('sep', '&', i, i + 1);
      i += 1;
      continue;
    }
    if (c === '>') {
      let v = '>';
      let e = i + 1;
      if (cmd[i + 1] === '>') { v = '>>'; e = i + 2; } else if (cmd[i + 1] === '|') { v = '>|'; e = i + 2; } else if (cmd[i + 1] === '&' && /[0-9-]/.test(cmd[i + 2] || '')) {
        // File-descriptor duplication (`2>&1`, `>&2`): no file destination.
        v = 'fddup';
        e = i + 2;
        while (e < n && /[0-9]/.test(cmd[e])) e += 1;
      }
      push('redir', v, i, e);
      i = e;
      continue;
    }
    if (c === '<') {
      let v = '<';
      let e = i + 1;
      if (cmd[i + 1] === '<') { v = '<<'; e = i + 2; } else if (cmd[i + 1] === '&' && /[0-9-]/.test(cmd[i + 2] || '')) {
        v = 'fddup';
        e = i + 2;
        while (e < n && /[0-9]/.test(cmd[e])) e += 1;
      }
      push('redir', v, i, e);
      i = e;
      continue;
    }
    const start = i;
    let buf = '';
    while (i < n) {
      const ch = cmd[i];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') break;
      if (ch === ';' || ch === '|' || ch === '&' || ch === '>' || ch === '<' || ch === '(' || ch === ')' || ch === '`') break;
      if (ch === '\\') { buf += cmd[i + 1] || ''; i += 2; continue; }
      if (ch === "'") {
        const close = cmd.indexOf("'", i + 1);
        const end = close === -1 ? n : close;
        buf += cmd.slice(i + 1, end);
        i = end + 1;
        continue;
      }
      if (ch === '"') {
        i += 1;
        while (i < n && cmd[i] !== '"') {
          if (cmd[i] === '\\') { buf += cmd[i + 1] || ''; i += 2; continue; }
          buf += cmd[i];
          i += 1;
        }
        i += 1;
        continue;
      }
      if (ch === '$' && cmd[i + 1] === '(') {
        let depth = 1;
        let j = i + 2;
        while (j < n && depth > 0) {
          if (cmd[j] === '(') depth += 1; else if (cmd[j] === ')') depth -= 1;
          j += 1;
        }
        buf += cmd.slice(i, j);
        i = j;
        continue;
      }
      buf += ch;
      i += 1;
    }
    if (buf) push('word', buf, start, i);
  }
  return toks;
};

// Destinations written by one simple command (the program plus its operands).
// `add` names a file, `addDir` names a directory that is itself the target (a
// checkout operated on through `git -C`, or the session tree for a path-less
// working-tree mutation).
const simpleCommandDestinations = (argv, add, addDir) => {
  let k = 0;
  while (k < argv.length && SHELL_PREFIX.has(path.basename(argv[k]))) {
    k += 1;
    while (k < argv.length && (/^-/.test(argv[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[k]))) k += 1;
  }
  const prog = argv[k] ? path.basename(argv[k]) : '';
  if (!prog) return;
  const rest = argv.slice(k + 1);
  const flagValues = SHELL_FLAG_VALUES[prog] || new Set();
  const ops = [];
  const targetDirs = [];
  const repoDirs = [];
  let scriptFlagSeen = false;
  for (let j = 0; j < rest.length; j++) {
    const tok = rest[j];
    if (tok === '--') { for (const tail of rest.slice(j + 1)) ops.push(tail); break; }
    if (flagValues.has(tok)) {
      const val = rest[j + 1];
      if (SHELL_SCRIPT_FLAGS.has(tok)) scriptFlagSeen = true;
      if (SHELL_TARGET_FLAGS.has(tok) && val !== undefined) targetDirs.push(val);
      if (GIT_REPO_FLAGS.has(tok) && val !== undefined) repoDirs.push(val);
      j += 1;
      continue;
    }
    if (/^-/.test(tok)) {
      if (/^(-e|--expression)/.test(tok)) scriptFlagSeen = true;
      continue;
    }
    ops.push(tok);
  }
  if (prog === 'git') {
    const sub = ops[0] || '';
    const subArgs = ops.slice(1);
    let writes = GIT_WRITE_SUBCOMMANDS.has(sub);
    if (sub === 'stash') writes = !['list', 'show'].includes(subArgs[0] || '');
    if (sub === 'branch') writes = subArgs.some((tok) => /^(-[dDmM]|--delete|--move|--set-upstream-to|-u)/.test(tok));
    if (sub === 'tag') writes = subArgs.length > 0;
    // A path-less working-tree mutation still owns the checkout it runs in. Only a
    // write registers its checkout: `git -C <repo> log` must stay read-only.
    if (!writes) return;
    if (repoDirs.length) { for (const dir of repoDirs) addDir(dir); return; }
    addDir('.');
    return;
  }
  if (targetDirs.length) { for (const dir of targetDirs) add(dir); return; }
  if (prog === 'dd') {
    for (const tok of rest) {
      const m = /^of=(.+)$/.exec(tok);
      if (m) add(m[1]);
    }
    return;
  }
  if (prog === 'tee') { for (const tok of ops) add(tok); return; }
  if (prog === 'sed') {
    if (!rest.some((tok) => /^(-i|--in-place)/.test(tok))) return;
    for (const tok of (scriptFlagSeen ? ops : ops.slice(1))) add(tok);
    return;
  }
  if (SHELL_ALL_OPERANDS.has(prog)) { for (const tok of ops) add(tok); return; }
  if (SHELL_LAST_OPERAND.has(prog) && ops.length) add(ops[ops.length - 1]);
};

// Destinations written by a shell command, as absolute paths; anything we cannot
// resolve (a `$VAR` target) is ignored rather than guessed, and `/dev/*` sinks name
// no file. A leading `cd <dir>` moves the base for the rest of the command string.
const shellWriteDestinations = (cmd, sessCwd, onFile, onDir) => {
  if (!cmd) return;
  const keep = (dest) => dest && !SHELL_BLACKHOLE.test(dest) && !/[`$]/.test(dest) && dest !== '&';
  let cwd = path.resolve(sessCwd);
  const absolute = (dest) => (path.isAbsolute(dest) ? dest : path.resolve(cwd, dest));
  const add = (dest) => { if (keep(dest)) onFile(absolute(dest)); };
  const addDir = (dest) => { if (keep(dest)) onDir(dest === '.' ? path.resolve(cwd) : absolute(dest)); };
  const toks = tokenizeShell(stripHeredocBodies(cmd));
  let argv = [];
  let prevWordEnd = -1;
  const flush = () => {
    if (!argv.length) return;
    const prog = path.basename(argv[0]);
    if (prog === 'cd') {
      const target = argv[1];
      if (target && target !== '-' && !/^~/.test(target)) cwd = path.resolve(cwd, target);
      argv = [];
      return;
    }
    simpleCommandDestinations(argv, add, addDir);
    argv = [];
  };
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'sep') { flush(); prevWordEnd = -1; continue; }
    if (tk.t === 'redir') {
      // `2>file`: the adjacent `2` is a file descriptor, not a command word.
      if ((tk.v === 'fddup' || SHELL_FD_PREFIXABLE.has(tk.v)) && argv.length &&
        /^\d+$/.test(argv[argv.length - 1]) && prevWordEnd === tk.s) argv.pop();
      const nxt = toks[i + 1];
      if (SHELL_REDIRECTS.has(tk.v)) {
        if (nxt && nxt.t === 'word') { add(nxt.v); i += 1; }
      } else if (nxt && nxt.t === 'word') {
        // Input redirection and fd duplication consume their operand but never
        // name a file this command writes.
        i += 1;
      }
      prevWordEnd = -1;
      continue;
    }
    argv.push(tk.v);
    prevWordEnd = tk.e;
  }
  flush();
};

const LANE_SCRIPT = (() => {
  try {
    return path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'scripts', 'dsh-lane.sh');
  } catch { return null; }
})();

// Repo roots this call writes, with the first destination that put them in play.
const claimTargets = (name, args, sessCwd) => {
  const targets = new Map();
  const offer = (root, dest) => { if (root && !targets.has(root)) targets.set(root, dest); };
  const resolve = (dest) => (path.isAbsolute(dest) ? dest : path.resolve(sessCwd, dest));
  const add = (dest) => {
    const abs = resolve(dest);
    offer(nearestRepoRoot(path.dirname(abs)), abs);
  };
  const addDir = (dest) => {
    const abs = resolve(dest);
    offer(nearestRepoRoot(abs), abs);
  };
  if (WRITE_TOOLS.has(name)) {
    const target = String(args.path || args.file_path || args.file || '');
    if (!target) {
      // No structured path (apply_patch and friends): fall back to the session tree.
      offer(nearestRepoRoot(sessCwd), path.resolve(sessCwd));
      return targets;
    }
    add(target);
    return targets;
  }
  shellWriteDestinations(String(args.command || args.cmd || ''), sessCwd, add, addDir);
  return targets;
};

const claimDenyReason = (root, dest, sessionId, mins) => [
  `这条调用会写 ${dest}，它属于 checkout ${root}：另一个会话（${String(sessionId).slice(-6)}，心跳 ${mins} 分钟前）正在那个工作树里工作。按代价从低到高选一条：`,
  '1) 任务只是只读分析/取数：把中间产物写到 /tmp 或仓外（例如 `... > /tmp/out.txt`、`tee /tmp/x`），再重试这条命令；纯只读任务不要建 lane。',
  '2) 任务确实要改这个仓：建 lane 再干 —— `bash ' + (LANE_SCRIPT || '<code-vibe 预设目录>/scripts/dsh-lane.sh') + ' create <repo> <task-id>`。脚本在 code-vibe 预设目录里，消费仓通常没有 scripts/dsh-lane.sh，不要在那个仓里找。',
  '3) 否则等它结束（心跳超过 15 分钟自动失效）。不要和另一个会话抢同一个工作树。',
].join('\n');

const isSubagent = (agent) => {
  try {
    const h = agent && agent.session && agent.session.header;
    if (h && (h.origin === 'subagent' || (h.delegationDepth || 0) > 0)) return true;
  } catch {}
  return false;
};

export const name = 'wish-gate';
export const inject = ['tools', 'systemPrompt'];

export function apply(ctx) {
  const stateOf = new WeakMap();
  const cleanupOf = new WeakMap();
  const get = (agent) => {
    let s = stateOf.get(agent);
    if (!s) {
      s = {
        skills: new Set(), failedSkill: null, failedSkillSurfaced: false,
        userPrompt: '', lastInjected: '', userSeq: 0,
        askedThisTurn: false, authz: false, commitAuth: false,
        turnText: '', steerBudget: 0,
      };
      stateOf.set(agent, s);
    }
    return s;
  };

  // Prompt policy: default is DO, not ASK.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'wish-gate-policy',
    order: 91,
    text: [
      'CONFIRMATION POLICY (necessity-only; the `wish-gate` plugin enforces the hard cases):',
      'Ask the user ONLY when one of these is true: (A) an irreversible/production action needs authorization or a rollback target; (B) a fact you need cannot be discovered from the workspace and only the user knows it; (C) the wish is taste-only (好看/更专业/看着办) with no object, field or acceptance criteria — ask ONE product tradeoff; (D) you found a conflict or replayed state and continuing would write wrong data.',
      'Otherwise DO NOT ask: do the work, then report with evidence. Never restate the user message as a confirmation ritual, never present multi-option menus for a concrete request, and never stop to ask on T3/program work (gap lists, backlog, batches, workers) — load the program skills and open the loop.',
      'QUESTIONS GO THROUGH `ask_user_question`, NEVER PROSE: a question written in your reply ends the turn without any gate and counts as stopping. Prose questions are forbidden. If the likely answer is "just continue", do not ask at all — take the reversible default, write the assumption down, and keep going.',
      'ASK NECESSITY (enforced): `ask_user_question` is only allowed for (A) authorization of an irreversible/production action, (B) a fact only the user knows, (C) a taste-only wish, (D) a detected conflict. A scope/direction question that has a reversible default is NOT allowed — choose the default and continue. Never end a turn on a question after announcing work you have not done.',
      'HARD NO-ASK: T0/T1/T2/T3/TR tasks with a complete request MUST NOT ask anything. T1: load `fix-loop`, run red, fix, run green, one negative control, 3-line report. T3: load program skills, open the loop. TR: produce findings with sources. TX: stop the bleeding first. Asking on these is a failure, not caution. ONE ask per user turn is the hard budget (`ask_user_question` is denied afterwards): finish the unblocked work first, park only the blocked slice.',
      'HANDOFF: when asked for a handoff, write docs/handoff.md with the seven fields directly (目标/已完成/未完成/决策/风险/下一步/涉及文件); do not ask and do not investigate beyond the workspace.',
      'Routing: data/migration, ops/production, cross-repo contract, multi-file, revamp must load `change-spec` (or `wish-programming` / `large-backlog-program`); design requests load `design-orchestrator` first; capacity/benchmark requests load `measurement-evidence`. Loading a skill is not a question.',
      'Evidence discipline: any factual claim about this repository must come from a command you actually ran (file path:line, or command + printed output). Never answer repo facts from memory; if the workspace has no such data, say so and give the path to obtain it.',
      'Commits: never run git commit/push unless the user asked for it (提交/commit/push/合入, or 搞定/收尾/首尾/交付). Destructive commands (kubectl delete/scale, rm -rf, git reset --hard …) are denied until the user explicitly authorizes that action and its rollback.',
      'READ-ONLY IS NOT AN ACTION: get/list/describe/log/status queries — including on staging or production — never need authorization and never need an ask; only mutations do.',
      'ANSWER FIRST: if the user asked a question, the first line answers it — progress reports never replace the answer.',
      'EXISTING DECISIONS: before proposing an architecture/design change, read the repo decisions (AGENTS.md, docs/**/DECISIONS|ADR|CURRENT, prior review docs) and quote them; a documented decision may only be changed by the user, not by the agent.',
      'LOOP BUDGET: same gap repaired ≥2 times, or 2 rounds without ledger decrement ⇒ stop and report "path is wrong" instead of another rebuild. Prefer a static scan over a dynamic rebuild loop.',
      'WAITING: when the only remaining work is a time window (soak/probe/24h gate), report the window once, schedule a readback (`schedule_create` or cron), and stop the loop — no periodic idle polling.',
      'SKILL FALLBACK: if a `skill` load returns "unknown", do not silently continue — say the gap in your reply and use a skill that exists in the catalog.',
      'READABILITY: the first three lines of every reply must answer "现在怎么样 / 要用户决定什么" in user language; push details into artifacts instead of dumping tables.',
    ].join('\n'),
  }));

  ctx.effect(() => {
    const off = ctx.on('agent/created', ({ agent }) => {
      const st = get(agent);
      const disposers = [];

      // P0-1: the request is the user's own message. Everything else (subagent
      // reports, memory/profile context, time context, teammate messages) is
      // injected context and may never authorize or route anything.
      disposers.push(agent.ctx.on('agent/inbox/claimed', ({ message }) => {
        const kind = message && message.source && message.source.kind;
        const text = textOf(message && message.content);
        if (kind === 'user') {
          st.userPrompt = text;
          st.userSeq += 1;
          st.askedThisTurn = false;
          const negated = NEGATED_RE.test(text);
          if (!negated && (AUTHORIZE_RE.test(text) || INSTRUCTION_DELETE_RE.test(text))) st.authz = true;
          if (!negated && COMMIT_AUTH_RE.test(text)) st.commitAuth = true;
          st.turnText = '';
          st.steerBudget = 0;
        } else {
          st.lastInjected = text;
        }
      }));

      // Track the visible assistant text of the current turn so the turn-stop guard
      // can tell "answered + asked for a decision" from "finished the work".
      disposers.push(agent.ctx.on('agent/assistant-stream', ({ frame }) => {
        try {
          if (!frame) return;
          if (frame.type === 'chunk' && frame.chunk && frame.chunk.type === 'text-delta' && frame.chunk.text) {
            st.turnText = (st.turnText + frame.chunk.text).slice(-6000);
          }
          if (frame.type === 'start') st.turnText = frame.step === 1 ? '' : st.turnText;
        } catch {}
      }));

      // Turn-stop guard: a turn must not end on a prose question after the agent
      // announced work it has not done. Object by steering once (budget 2/turn).
      disposers.push(agent.ctx.on('agent/turn-stopping', async ({ agent: who }) => {
        if (process.env.WISH_GATE_STEER === '0') return;
        const t = (st.turnText || '').trim();
        st.turnText = '';
        if (!t || isSubagent(who)) return;
        const endsWithQuestion = /[？?]\s*$/.test(t) || /(你一句话|你说了算|需要你(决定|拍板)|要你(决定|拍板)|等你确认|你说一声|要不要我)/.test(t);
        const announcedWork = /(我按.{0,20}(改|做|补|重|跑)|接下来我|我现在(就|去)|我直接|我继续|下一步我|我来(改|做|补)|我先去)/.test(t);
        const askForAuthorization = /(授权|批准|放行|允许我|回滚口径|可以删|可以执行)/.test(t);
        if (!endsWithQuestion || !announcedWork || askForAuthorization) return;
        if (st.steerBudget >= 2) return;
        st.steerBudget += 1;
        const msg = {
          id: 'wish-gate-steer-' + Date.now().toString(36),
          role: 'user',
          content: [{
            type: 'text',
            text: '【wish-gate 自动续跑】你上一条已经写明你要做的整改/动作，但还没做完就停下来要用户拍板了。现在继续：先把不依赖这个回答的工作全部做完并给出证据，再把真正需要用户决定的那一件用 ask_user_question 问一次（正文里提问不算，等于停下来）。不要空转、不要只回话。',
          }],
          source: { kind: 'wish-gate' },
        };
        try {
          who.steer(msg);
        } catch {
          try { who.steer({ ...msg, source: { kind: 'user' } }); } catch {}
        }
      }));

      disposers.push(agent.ctx.on('tools/result', (exec) => {
        const n = exec && exec.name;
        if (n === 'skill') {
          const a = parse(exec.arguments);
          const nm = a.name || a.skill || a.id;
          const txt = resultText(exec);
          if (nm && /unknown or no longer available|Error: skill|not found/i.test(txt)) {
            st.failedSkill = nm;
            st.failedSkillSurfaced = false;
          } else if (nm) {
            st.skills.add(nm);
          }
        }
        if (n === 'ask_user_question') {
          st.askedThisTurn = true;
          const txt = resultText(exec);
          if (txt && APPROVAL_ANSWER_RE.test(txt)) st.authz = true;
        }
      }));

      disposers.push(agent.ctx.on('tools/pre-execute', async (exec, next) => {
        const n = exec && exec.name;
        const a = parse(exec.arguments);
        const st = get(agent);
        const p = st.userPrompt || '';
        const sub = isSubagent(agent);

        if (n === 'skill') return next();
        if (n === 'ask_user_question') {
          if (sub) return next();
          if (st.askedThisTurn) {
            return { kind: 'deny', reason: '同一用户轮只允许一次确认：先把能做的工作做完，把剩下的写成"需要你拍板的一行清单"，不要再问。' };
          }
          const askText = JSON.stringify(a && a.questions || a || '');
          const designAsk = st.skills.has('design-orchestrator') && /(冻结|freeze|评审|确认包|L1|L2|L3)/i.test(askText);
          const necessary =
            (OPS_RE.test(p) && !st.authz) ||            // A. authorization for an irreversible action
            MISSING_FACT_RE.test(p) || CONFLICT_RE.test(p) || // B/D. only the user knows / conflict
            (VAGUE_RE.test(p) && !CONCRETE_RE.test(p)) ||     // C. taste-only wish
            designAsk;                                        // design freeze/review confirmation
          if (!necessary) {
            return {
              kind: 'deny',
              reason: '这个问题不需要用户：它有一个可逆默认。按默认继续、把假设写成一行，做完再一起报；确实不可逆/只有用户知道的，才允许问一次。',
            };
          }
          return next();
        }

        const isBash = n === 'bash' || n === 'Bash';
        const cmd = isBash ? String(a.command || a.cmd || '') : '';
        const bashWrite = isBash && /(^|[^<])>{1,2}\s*\S|\btee\s|\bgit\s+apply\b|\bsed\s+-i\b|\bpython3?\b[^\n]*<<[\'\"]?[A-Z]/.test(cmd);
        const writeLike = WRITE_TOOLS.has(n) || bashWrite;
        const gated = writeLike || GATED_TOOLS.has(n) || isBash;
        if (!gated) return next();

        // ---- safety gates (both top-level and workers) ----
        if (isBash) {
          if (/\bgit\s+worktree\s+(?:add|remove|move|repair)\b/.test(cmd)) {
            return {
              kind: 'deny',
              reason: 'worktree 只能通过 `' + (LANE_SCRIPT || '<code-vibe 预设目录>/scripts/dsh-lane.sh') + '` 管理（lane 规则：一任务一 lane、登记制、合并预演、清理）；裸 `git worktree add/remove/move/repair` 不允许。脚本在 code-vibe 预设目录里，消费仓通常没有 scripts/dsh-lane.sh，不要在那个仓里找。',
            };
          }
          const destructive = DESTRUCTIVE_RE.test(cmd);
          const isolated = SAFE_BED_RE.test(cmd) && !PROD_RE.test(cmd);
          const tmpOnly = /\brm\s+-[a-zA-Z]*[rf]/.test(cmd) && SAFE_PATH_RE.test(cmd) && !/rm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+\/(\s|$)/.test(cmd);
          if (destructive && !isolated && !tmpOnly && !st.authz) {
            return {
              kind: 'deny',
              reason: sub
                ? '破坏性命令需要用户授权：worker 不要向用户发问，把这条写进回报让 Lead 要授权（含回滚口径）。'
                : '破坏性命令（delete/scale/reset --hard/rm -rf …）需要用户明确授权：先问一次"删哪些 + 回滚口径"，拿到答复再执行。',
            };
          }
          if (/\bgit\s+(commit|push)\b/.test(cmd) && !st.commitAuth) {
            return { kind: 'deny', reason: '提交门：用户没有要求提交，先别 commit/push（用户在说"提交/搞定/收尾"后才放开）。' };
          }
        }

        // P0-3: workers execute; the Lead owns routing/authorization. Keep only
        // worktree/destructive/commit gates above, plus the skill-failure surface.
        if (sub) {
          if (st.failedSkill && !st.failedSkillSurfaced && writeLike) {
            st.failedSkillSurfaced = true;
            return { kind: 'deny', reason: `skill「${st.failedSkill}」不存在：不要静默继续，先改用目录里存在的技能，并把这条缺口写进回报给 Lead。` };
          }
          return next();
        }

        // ---- cross-session checkout ownership (top-level only) ----
        // Workers inherit the Lead's working tree, so they never claim their own.
        // Only the paths this call writes are considered: a call with no explicit
        // destination is read-only for the checkout — it neither loses nor takes the
        // claim. The heartbeat itself is refreshed at the end of the chain, so an op
        // that a later gate denies never leaves a live claim behind.
        const sessId = (agent.session && (agent.session.header && agent.session.header.id || agent.session.id)) || 'unknown';
        const sessCwd = (agent.session && agent.session.header && agent.session.header.cwd) || process.cwd();
        let claimWrite = null;
        // Keyed on destinations, not on `writeLike`: `cp a <repo>/b` and
        // `git apply x.diff` are real working-tree writes without a redirect.
        if (writeLike || isBash) {
          const targets = claimTargets(n, a, sessCwd);
          if (targets.size) {
            const now = Date.now();
            for (const [root, dest] of targets) {
              const other = otherLiveClaim(claimsFileFor(root), root, sessId, now);
              if (other) {
                const mins = Math.max(1, Math.round((now - Number(other.ts || now)) / 60000));
                return { kind: 'deny', reason: claimDenyReason(root, dest, other.sessionId, mins) };
              }
            }
            claimWrite = targets;
          }
        }

        // ---- top-level gates ----
        const designDomainLoaded = Array.from(st.skills).some((s) => DESIGN_DOMAIN_SKILLS.has(s));
        const orchestrator = st.skills.has('design-orchestrator');
        const designTask = DESIGN_RE.test(p);
        const targetPath = String(a.path || a.file_path || a.file || '');
        const isDesignPath = targetPath.includes('docs/design/') || targetPath.includes('docs/design\\');

        if (st.failedSkill && !st.failedSkillSurfaced && writeLike) {
          st.failedSkillSurfaced = true;
          return { kind: 'deny', reason: `skill「${st.failedSkill}」不存在（目录里没有）：先告诉用户这条缺失，并改用存在的技能继续，不要静默换招。` };
        }

        // design orchestration + freeze (P1)
        if (writeLike && isDesignPath && !orchestrator) {
          return { kind: 'deny', reason: '设计件（docs/design/**）必须经 `design-orchestrator` 编排后创建：先加载它判层/定档/列件/定评审，再写。' };
        }
        if (writeLike && designTask && !orchestrator) {
          return { kind: 'deny', reason: '设计类请求：先加载 `design-orchestrator`（判 L1/L2/L3、列最小件、定评审），再写实现或设计件。' };
        }
        if (writeLike && (orchestrator || (designDomainLoaded && designTask)) && !isDesignPath && path.isAbsolute(targetPath)) {
          const frozen = (() => {
            let dir = path.dirname(targetPath);
            for (let i = 0; i < 6; i++) {
              const designRoot = path.join(dir, 'docs', 'design');
              try {
                for (const id of fs.readdirSync(designRoot)) {
                  if (fs.existsSync(path.join(designRoot, id, 'freeze.md'))) return true;
                }
              } catch {}
              const parent = path.dirname(dir);
              if (parent === dir) break;
              dir = parent;
            }
            return false;
          })();
          if (!frozen) {
            return { kind: 'deny', reason: '冻结门：设计轨道已启动，但仓库里没有 docs/design/<id>/freeze.md。先完成评审与冻结（L2/L3 需用户确认）再写实现。' };
          }
        }

        const isT3 = T3_RE.test(p);
        if (isT3 && writeLike && !st.skills.has('large-backlog-program') && !st.skills.has('agent-team-project-loop')) {
          return { kind: 'deny', reason: 'T3/清单类：先加载 `large-backlog-program` 或 `agent-team-project-loop` 再动手（协调类工具不受限）。' };
        }

        // ops authorization applies in every tier (a production mutation is not a
        // program batch); the "missing fact / vague wish" asks are T3-exempt.
        const otherAsk = MISSING_FACT_RE.test(p) || CONFLICT_RE.test(p) || (VAGUE_RE.test(p) && !CONCRETE_RE.test(p));
        if (writeLike && OPS_RE.test(p) && !st.authz && !st.askedThisTurn) {
          return { kind: 'deny', reason: '涉及生产/不可逆动作：先问一次（做什么 + 回滚口径），拿到明确授权再写。' };
        }
        if (!isT3 && writeLike && otherAsk && !st.authz && !st.askedThisTurn) {
          return { kind: 'deny', reason: '这里缺一个只有用户能给的信息（目标/口径/取向）：问一次即可，其余不要问。' };
        }
        if (!isT3 && writeLike && T3WISH_RE.test(p) && !st.askedThisTurn && !st.authz) {
          return { kind: 'deny', reason: '改版/多页重做：先给出定位与方案预览，并用 ask_user_question 确认一次，再动文件。' };
        }

        // routing: nothing writes/executes before its skill is loaded. Plain
        // read-only bash (kubectl get / git status / ls) is NOT a write and must
        // not pay the skill tax — only writeLike or a delegation needs the skill.
        if ((writeLike || DELEGATE_TOOLS.has(n)) && !REVIEW_RE.test(p)) {
          for (const rule of ROUTING_RULES) {
            if ((rule.re === WISH_ROUTE_RE || rule.re === REVAMP_RE) && orchestrator) continue;
            if (rule.re.test(p) && !rule.need.some((s) => st.skills.has(s))) {
              if (isT3 && ['large-backlog-program', 'agent-team-project-loop'].some((s) => st.skills.has(s))) continue;
              return { kind: 'deny', reason: '先加载对应 skill 再动手：' + rule.msg + '。当前已加载：' + (Array.from(st.skills).join('、') || '无') };
            }
          }
        }
        // The call is allowed: only now does it take (or renew) the checkout claim,
        // and only for the roots it actually writes.
        if (claimWrite) {
          const at = Date.now();
          for (const root of claimWrite.keys()) refreshClaim(claimsFileFor(root), root, sessId, at);
        }
        return next();
      }));

      disposers.push(agent.ctx.on('agent/disposed', () => { const f = cleanupOf.get(agent); if (f) f(); }));
      cleanupOf.set(agent, () => { for (const d of disposers) { try { d && d(); } catch {} } disposers.length = 0; });
    });
    return () => { try { off && off(); } catch {} };
  });
}
