// wish-gate contract tests (durable, no deps): node scripts/test-wish-gate.mjs
//
// Every case below is a real defect observed in the 2026-10-27..11-01 sessions
// (see docs/GATE-FIX-REPORT-20261101.md). Red first, then green.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GATE = process.env.GATE ||
  '/home/pc/.dsh/.agent-presets/code-vibe/plugins/wish-gate.js';
const mod = await import(GATE);

const created = [];
const ctx = {
  effect: (fn) => { fn(); return () => {}; },
  on: (ev, cb) => { if (ev === 'agent/created') created.push(cb); return () => {}; },
  systemPrompt: { section: () => () => {} },
};
mod.apply(ctx);
if (!created.length) { console.log('FAIL no agent/created hook'); process.exit(1); }

let agentSeq = 0;
// The suite must not touch the checkout it runs from: a default agent cwd of
// process.cwd() made every relative write claim THIS repo, which then denied every
// later case that ran inside it. Cases that need a checkout pass `cwd` explicitly.
const NEUTRAL_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cwd-'));
const newAgent = (header = {}) => {
  const h = {};
  const id = header.id || `session-test-${++agentSeq}`;
  const agent = {
    session: { id, header: { id, origin: undefined, delegationDepth: 0, cwd: NEUTRAL_CWD, ...header } },
    ctx: { on: (ev, cb) => { h[ev] = cb; return () => {}; } },
  };
  created[0]({ agent });
  return h;
};
const text = (s) => [{ type: 'text', text: s }];
const user = (h, s) => h['agent/inbox/claimed']({ message: { role: 'user', source: { kind: 'user' }, content: text(s) } });
const inject = (h, kind, s) => h['agent/inbox/claimed']({ message: { role: 'user', source: { kind }, content: text(s) } });
const skill = (h, name, ok = true) => h['tools/result']({
  name: 'skill',
  arguments: JSON.stringify({ name }),
  result: { content: text(ok ? `<skill_content name="${name}">...` : `Error: skill "${name}" is unknown or no longer available`) },
});
const askResult = (h, answer) => h['tools/result']({ name: 'ask_user_question', arguments: '{}', result: { content: text(answer) } });
const run = async (h, name, args = {}) => {
  let next = false;
  const r = await h['tools/pre-execute']({ name, arguments: JSON.stringify(args) }, () => { next = true; return null; });
  return { denied: !!(r && r.kind === 'deny'), reason: (r && r.reason) || '', next };
};

let ok = 0, fail = 0;
const out = [];
const check = async (label, fn) => {
  try {
    const msg = await fn();
    if (msg === true) { ok++; out.push(`PASS ${label}`); }
    else { fail++; out.push(`FAIL ${label}  ${msg || ''}`); }
  } catch (e) { fail++; out.push(`FAIL ${label}  threw ${String(e && e.message || e)}`); }
};

// ── P0-1: only a real user message sets the request; injected context must not ──
await check('P0-1 subagent report does not hijack the request (send_message stays open)', async () => {
  const h = newAgent();
  user(h, '提交');
  inject(h, 'subagent-settled', '我把预览环境的身份门修好了：事故已止血，回滚已完成，重建了 3 个 Pod');
  const r = await run(h, 'send_message', { target: 'worker', message: '继续' });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('P0-1 injected memory containing 提交 does not authorize commit', async () => {
  const h = newAgent();
  user(h, '先看看这个问题');
  inject(h, 'profile', '上次会话把改动提交了，commit 记录在案');
  const r = await run(h, 'bash', { command: 'git commit -m x' });
  return r.denied ? true : 'commit was allowed by injected text';
});
await check('P0-1 real user request still drives routing (T1 edit needs fix-loop)', async () => {
  const h = newAgent();
  user(h, '把 test_orders 修绿。');
  const r = await run(h, 'edit', { path: 'tests/test_orders.py', old: 'a', new: 'b' });
  return r.denied && /fix-loop/.test(r.reason) ? true : JSON.stringify(r);
});

// ── P0-2: routing must not block team/coordination tools ──
await check('P0-2 research request: send_message allowed before research skill loads', async () => {
  const h = newAgent();
  user(h, '调研一下这个系统的架构，做对比分析');
  const r = await run(h, 'send_message', { target: 'w', message: '第一片' });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('P0-2 T3 program: team_task_create allowed before program skill loads', async () => {
  const h = newAgent();
  user(h, '按 gap 清单开环，派 worker 收掉这些批次');
  const r = await run(h, 'team_task_create', { subject: 'x', description: 'y' });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('P0-2 T3 program: write still requires a program skill', async () => {
  const h = newAgent();
  user(h, '按 gap 清单开环，派 worker 收掉这些批次');
  const r = await run(h, 'write', { path: 'docs/gap.md', content: 'x' });
  return r.denied ? true : 'write was allowed with no program skill';
});
await check('P0-2 job_output / todo_write never gated', async () => {
  const h = newAgent();
  user(h, '调研一下这个系统的架构，做对比分析');
  const a = await run(h, 'job_output', { job_id: 'j1' });
  const b = await run(h, 'todo_write', { todos: [] });
  return (!a.denied && !b.denied) ? true : `${JSON.stringify(a)} ${JSON.stringify(b)}`;
});

// ── P0-3: workers are not the user's counterparty ──
await check('P0-3 worker subagent: staging brief does not demand user authorization', async () => {
  const h = newAgent({ origin: 'subagent', delegationDepth: 1 });
  user(h, '修复投影链：拿 staging 的 ConfigMap 重建，回滚窗口 5 分钟，已获用户批准。');
  const r = await run(h, 'bash', { command: 'kubectl -n lakeweaver-staging rollout restart deploy/ops-runner' });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('P0-3 worker subagent: routing skill-first not enforced inside worker', async () => {
  const h = newAgent({ origin: 'subagent', delegationDepth: 1 });
  user(h, '修一下这个 bug：数据迁移 DDL 建表，重建契约');
  const r = await run(h, 'write', { path: 'src/x.py', content: 'x' });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('P0-3 top-level agent is still gated (negative control)', async () => {
  const h = newAgent();
  user(h, '把 nginx conf 切到新版本，然后重启。');
  const r = await run(h, 'write', { path: 'nginx.conf', content: 'x' });
  return r.denied ? true : 'top-level ops write was allowed with no authorization';
});

// ── P0-4: every skill the gate points at must exist ──
await check('P0-4 gate only references skills that exist', async () => {
  const src = fs.readFileSync(GATE, 'utf8');
  const dir = path.resolve(path.dirname(GATE), '..', 'skills');
  const names = new Set(fs.readdirSync(dir));
  const refs = [...src.matchAll(/`([a-z][a-z0-9-]{3,})`/g)].map((m) => m[1]);
  const known = new Set([
    'fix-loop', 'research-brief', 'incident-runbook', 'change-spec', 'large-backlog-program',
    'agent-team-project-loop', 'design-orchestrator', 'lane-worktree', 'wish-programming',
    'task-router', 'business-design', 'product-design', 'information-architecture',
    'interaction-visual-design', 'ux-research', 'architecture-design', 'tech-design',
    'tech-selection', 'measurement-evidence', 'ledger-close-not-construction-done',
  ]);
  const missing = refs.filter((r) => known.has(r) && !names.has(r));
  return missing.length ? `missing skills: ${missing.join(',')}` : true;
});

// ── P0-5: destructive commands need explicit authorization ──
await check('P0-5 kubectl delete staging workload without authorization denied', async () => {
  const h = newAgent();
  user(h, '遗留三件也需要修复');
  const r = await run(h, 'bash', { command: 'kubectl -n lakeweaver-staging delete deploy sqlmesh-ui' });
  return r.denied && /破坏性|授权/.test(r.reason) ? true : `reason: ${r.reason}`;
});
await check('P0-5 kubectl delete allowed after explicit user authorization', async () => {
  const h = newAgent();
  user(h, '批准：把 staging 的 sqlmesh-ui 删掉，回滚就是重新 apply 清单。');
  skill(h, 'change-spec');
  const r = await run(h, 'bash', { command: 'kubectl -n lakeweaver-staging delete deploy sqlmesh-ui' });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('P0-5 destructive delete allowed after the user answers the authorization ask', async () => {
  const h = newAgent();
  user(h, '遗留三件也要处理');
  await run(h, 'ask_user_question', { questions: [{ id: 'q', question: '可以删吗' }] });
  askResult(h, '批准，按这个删，回滚口径是重新 apply 原清单');
  skill(h, 'change-spec');
  const r = await run(h, 'bash', { command: 'kubectl -n lakeweaver-staging delete deploy sqlmesh-ui' });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('P0-5 rm -rf workspace dir denied without authorization', async () => {
  const h = newAgent();
  user(h, '先看看这个目录');
  const r = await run(h, 'bash', { command: 'rm -rf /home/pc/code/lakeweaver-workspace/lakeweaver-platform/docs' });
  return r.denied ? true : 'rm -rf was allowed';
});
await check('P0-5 git reset --hard denied without authorization (negative control: read-only git ok)', async () => {
  const h = newAgent();
  user(h, '看看现在改了什么');
  const bad = await run(h, 'bash', { command: 'git reset --hard HEAD~1' });
  const good = await run(h, 'bash', { command: 'git status --porcelain' });
  return bad.denied && !good.denied ? true : `${JSON.stringify(bad)} ${JSON.stringify(good)}`;
});

await check('P0-5 explicit "删掉 X" instruction counts as authorization', async () => {
  const h = newAgent();
  user(h, '把 /tmp/gate-e2e/repo/.git 删掉，然后重新初始化');
  const r = await run(h, 'bash', { command: 'rm -rf /tmp/gate-e2e/repo/.git' });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('P0-5 "不要删" is not an authorization', async () => {
  const h = newAgent();
  user(h, '先别删任何东西，只是看看');
  skill(h, 'change-spec');
  const r = await run(h, 'bash', { command: 'rm -rf /home/pc/data' });
  return r.denied ? true : 'negated instruction authorized deletion';
});
await check('P0-5 git checkout -- / git restore are destructive', async () => {
  const h = newAgent();
  user(h, '看看现在有什么改动');
  const a = await run(h, 'bash', { command: 'git checkout -- .' });
  const b = await run(h, 'bash', { command: 'git restore src/app.py' });
  return a.denied && b.denied ? true : `${JSON.stringify(a)} ${JSON.stringify(b)}`;
});

// ── P0-6: commit authorization ──
await check('P0-6 unrequested commit denied', async () => {
  const h = newAgent();
  user(h, '把 README 的 typo 改一下');
  const r = await run(h, 'bash', { command: 'git commit -m x' });
  return r.denied ? true : 'unrequested commit allowed';
});
await check('P0-6 "搞定收尾" authorizes commit (no extra ask)', async () => {
  const h = newAgent();
  user(h, '你全部搞定吧，收尾。');
  const r = await run(h, 'bash', { command: 'git commit -m x' });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('P0-6 explicit "提交" authorizes commit and stays open for later commits', async () => {
  const h = newAgent();
  user(h, '提交');
  const a = await run(h, 'bash', { command: 'git commit -m x' });
  const b = await run(h, 'bash', { command: 'git commit -m y' });
  return (!a.denied && !b.denied) ? true : `first=${JSON.stringify(a)} second=${JSON.stringify(b)}`;
});

await check('P0-2 read-only ops bash needs no skill (kubectl get)', async () => {
  const h = newAgent();
  user(h, '用 .kube/lakeweaver-staging.yaml 拉一下 staging 的 pod 列表，只读');
  const r = await run(h, 'bash', { command: 'KUBECONFIG=.kube/lakeweaver-staging.yaml kubectl -n lakeweaver-staging get pods' });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('P0-2 ops bash that writes still needs change-spec', async () => {
  const h = newAgent();
  user(h, '把 staging 的 pod 列表写到文件里');
  const r = await run(h, 'bash', { command: 'kubectl -n lakeweaver-staging get pods > /tmp/pods.txt' });
  // ask-once or skill-first may land first; both are legitimate, silence is not
  return r.denied && /change-spec|先问一次|授权/.test(r.reason) ? true : `reason: ${r.reason}`;
});

await check('P1 "worker_processes" is not a T3 program (no program-skill deny)', async () => {
  const h = newAgent();
  user(h, '把 nginx.conf 里的 worker_processes 改成 4，然后重启 nginx。');
  const r = await run(h, 'edit', { path: 'nginx.conf', old: 'worker_processes 1;', new: 'worker_processes 4;' });
  return r.denied && /large-backlog-program|agent-team-project-loop/.test(r.reason) ? `false T3: ${r.reason}` : true;
});
await check('P1 "debug" is not a bug fix (no fix-loop deny)', async () => {
  const h = newAgent();
  user(h, '把 debug 日志级别改成 info');
  const r = await run(h, 'edit', { path: 'config.yaml', old: 'debug', new: 'info' });
  return r.denied && /fix-loop/.test(r.reason) ? `false T1: ${r.reason}` : true;
});
await check('P1 ops write in a T3 program still needs authorization', async () => {
  const h = newAgent();
  user(h, '按 gap 清单开环，把 staging 的 nginx 配置切到新版本');
  skill(h, 'large-backlog-program');
  const r = await run(h, 'write', { path: 'nginx.conf', content: 'x' });
  return r.denied && /授权|回滚/.test(r.reason) ? true : `reason: ${r.reason}`;
});

// ── P1: concurrent checkout ownership (lane default) ──
await check('P1 another live session writing the same checkout is denied with a lane hint', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-'));
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const a = newAgent({ id: 'session-a', cwd: repo });
  user(a, '写一个说明文件');
  const ra = await run(a, 'write', { path: path.join(repo, 'notes.txt'), content: 'x' });
  const b = newAgent({ id: 'session-b', cwd: repo });
  user(b, '写另一个说明文件');
  const rb = await run(b, 'write', { path: path.join(repo, 'other.txt'), content: 'x' });
  return (!ra.denied && rb.denied && /lane|dsh-lane/.test(rb.reason)) ? true : `a=${JSON.stringify(ra)} b=${JSON.stringify(rb)}`;
});
await check('P1 a stale claim does not block a new session', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'claim2-'));
  const dotgit = path.join(repo, '.git');
  fs.mkdirSync(dotgit, { recursive: true });
  fs.writeFileSync(path.join(dotgit, 'dsh-claims.jsonl'),
    JSON.stringify({ root: repo, sessionId: 'session-old', pid: 1, ts: Date.now() - 3 * 60 * 60 * 1000 }) + '\n');
  const b = newAgent({ id: 'session-new', cwd: repo });
  user(b, '写文件');
  const rb = await run(b, 'write', { path: path.join(repo, 'x.txt'), content: 'x' });
  return rb.denied ? `denied: ${rb.reason}` : true;
});
await check('P1 a lane worktree is a different root (no false conflict)', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'claim3-'));
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const lane = fs.mkdtempSync(path.join(os.tmpdir(), 'claim3-lane-'));
  fs.writeFileSync(path.join(lane, '.git'), `gitdir: ${repo}/.git/worktrees/lane\n`);
  const a = newAgent({ id: 'session-main', cwd: repo });
  user(a, '写');
  await run(a, 'write', { path: path.join(repo, 'a.txt'), content: 'x' });
  const b = newAgent({ id: 'session-lane', cwd: lane });
  user(b, '写');
  const rb = await run(b, 'write', { path: path.join(lane, 'b.txt'), content: 'x' });
  return rb.denied ? `denied: ${rb.reason}` : true;
});

// ── v11: the claim keys on write DESTINATIONS, not on command shape ──
// The 2026-11-02 defect: a read-only analysis session inside a checkout another
// session held was denied (and pushed into creating a lane) for `python3 - <<'PY'`
// or `... > /tmp/x`; the mirror image was that such a session silently claimed the
// checkout and locked the real coder out for the 15 min heartbeat.
const claimedRepo = () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-v11-'));
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return repo;
};
const claimsIn = (repo) => {
  try {
    return fs.readFileSync(path.join(repo, '.git', 'dsh-claims.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};
// A session whose write is actually allowed: no routing rule matches this request.
const owningSession = async (repo, id = 'session-owner') => {
  const h = newAgent({ id, cwd: repo });
  user(h, '写一个说明文件');
  const r = await run(h, 'write', { path: path.join(repo, 'notes.txt'), content: 'x' });
  if (r.denied) throw new Error(`owner write denied: ${r.reason}`);
  return h;
};
const analysisSession = (repo, id) => {
  const h = newAgent({ id, cwd: repo });
  user(h, '看下实验的样本量是否达标，把结论给我');
  return h;
};

await check('v11 heredoc into python is not a file write (claimed checkout stays usable)', async () => {
  const repo = claimedRepo();
  await owningSession(repo);
  const b = analysisSession(repo, 'session-readonly-heredoc');
  const r = await run(b, 'bash', { command: "python3 - <<'PY'\nprint(sum([1, 2, 3]))\nPY" });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('v11 redirect to /tmp is allowed inside a claimed checkout', async () => {
  const repo = claimedRepo();
  await owningSession(repo);
  const b = analysisSession(repo, 'session-readonly-tmp');
  const heredoc = await run(b, 'bash', { command: `python3 - <<'PY'\nprint(1)\nPY > ${path.join(os.tmpdir(), 'gate-v11-sample.txt')}` });
  const plain = await run(b, 'bash', { command: `echo sample > ${path.join(os.tmpdir(), 'gate-v11-sample2.txt')}` });
  const tee = await run(b, 'bash', { command: `echo sample | tee ${path.join(os.tmpdir(), 'gate-v11-sample3.txt')}` });
  return (!heredoc.denied && !plain.denied && !tee.denied) ? true : `${JSON.stringify(heredoc)} ${JSON.stringify(plain)} ${JSON.stringify(tee)}`;
});
await check('v11 fd redirection (2>&1, 2>/dev/null) is not a destination', async () => {
  const repo = claimedRepo();
  await owningSession(repo);
  const b = analysisSession(repo, 'session-readonly-fd');
  const a = await run(b, 'bash', { command: 'python3 analyze.py 2>&1 | head -20' });
  const c = await run(b, 'bash', { command: 'python3 analyze.py 2>/dev/null' });
  const d = await run(b, 'bash', { command: 'git log --oneline -5 > /dev/null 2>&1' });
  return (!a.denied && !c.denied && !d.denied) ? true : `${JSON.stringify(a)} ${JSON.stringify(c)} ${JSON.stringify(d)}`;
});
await check('v11 genuine in-repo write by a second session is still denied with a lane hint', async () => {
  const repo = claimedRepo();
  await owningSession(repo);
  const b = newAgent({ id: 'session-second-writer', cwd: repo });
  user(b, '写另一个说明文件');
  const redirect = await run(b, 'bash', { command: `echo hi > ${path.join(repo, 'out.txt')}` });
  const tee = await run(b, 'bash', { command: `echo hi | tee ${path.join(repo, 'tee.txt')}` });
  const write = await run(b, 'write', { path: path.join(repo, 'notes2.txt'), content: 'x' });
  const reasons = [redirect, tee, write].map((r) => r.reason);
  const ok = redirect.denied && tee.denied && write.denied
    && reasons.every((reason) => /dsh-lane\.sh/.test(reason) && /\/tmp/.test(reason)
      && /只读/.test(reason) && !/默认走 lane/.test(reason));
  return ok ? true : `redirect=${JSON.stringify(redirect)} tee=${JSON.stringify(tee)} write=${JSON.stringify(write)}`;
});
await check('v11 relative redirect resolves against the session cwd (still denied)', async () => {
  const repo = claimedRepo();
  await owningSession(repo);
  const b = newAgent({ id: 'session-second-relative', cwd: repo });
  user(b, '写另一个说明文件');
  const redirect = await run(b, 'bash', { command: 'echo hi > out.txt' });
  const tee = await run(b, 'bash', { command: 'echo hi | tee out.txt' });
  const sedInPlace = await run(b, 'bash', { command: "sed -i 's/a/b/' notes.txt" });
  return (redirect.denied && tee.denied && sedInPlace.denied)
    ? true
    : `redirect=${JSON.stringify(redirect)} tee=${JSON.stringify(tee)} sed=${JSON.stringify(sedInPlace)}`;
});
await check('v11 destinations outside any repo are not a claim conflict (negative control)', async () => {
  const repo = claimedRepo();
  await owningSession(repo);
  const b = newAgent({ id: 'session-outside-writer', cwd: NEUTRAL_CWD });
  user(b, '写一个说明文件到临时目录');
  const r = await run(b, 'bash', { command: `mkdir -p ${path.join(os.tmpdir(), 'gate-v11-out')} && echo hi > ${path.join(os.tmpdir(), 'gate-v11-out', 'x.txt')}` });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('v11 path-less working-tree mutations (git apply/merge) are still claim conflicts', async () => {
  const repo = claimedRepo();
  await owningSession(repo);
  const b = newAgent({ id: 'session-git-writer', cwd: repo });
  user(b, '看下这个补丁，能应用就应用');
  const apply = await run(b, 'bash', { command: 'git apply fix.diff' });
  const merge = await run(b, 'bash', { command: 'git merge origin/dev' });
  const stash = await run(b, 'bash', { command: 'git stash pop' });
  const log = await run(b, 'bash', { command: 'git log --oneline -3' });
  const status = await run(b, 'bash', { command: 'git status --short' });
  const diff = await run(b, 'bash', { command: 'git diff --stat' });
  const stashList = await run(b, 'bash', { command: 'git stash list' });
  const deniedWithClaim = [apply, merge, stash].every((r) => r.denied && /dsh-lane\.sh/.test(r.reason));
  const readsAllowed = !log.denied && !status.denied && !diff.denied && !stashList.denied;
  return (deniedWithClaim && readsAllowed)
    ? true
    : `apply=${JSON.stringify(apply)} merge=${JSON.stringify(merge)} stash=${JSON.stringify(stash)} log=${log.denied} status=${status.denied} diff=${diff.denied} stashList=${stashList.denied}`;
});
await check('v11 operand writes (cp/mkdir/truncate/rm) inside a claimed checkout are denied', async () => {
  const repo = claimedRepo();
  await owningSession(repo);
  const b = newAgent({ id: 'session-operand-writer', cwd: repo });
  user(b, '整理一下这个目录');
  const cp = await run(b, 'bash', { command: 'cp /etc/hosts copy.txt' });
  const mkdir = await run(b, 'bash', { command: 'mkdir -p docs/new' });
  const truncate = await run(b, 'bash', { command: 'truncate -s 0 notes.txt' });
  const rm = await run(b, 'bash', { command: 'rm notes.txt' });
  const out = { cp, mkdir, truncate, rm };
  const allDenied = Object.values(out).every((r) => r.denied && /dsh-lane\.sh/.test(r.reason));
  return allDenied ? true : JSON.stringify(out);
});
await check('v11 a leading cd moves the base for relative destinations', async () => {
  const repo = claimedRepo();
  await owningSession(repo);
  const b = analysisSession(repo, 'session-cd');
  const outside = await run(b, 'bash', { command: 'cd /tmp && echo sample > gate-v11-cd.txt' });
  const outsideSub = await run(b, 'bash', { command: '( cd /tmp && echo sample > gate-v11-cd-sub.txt )' });
  const inside = await run(b, 'bash', { command: `cd ${repo} && echo hi > cd-out.txt` });
  return (!outside.denied && !outsideSub.denied && inside.denied && /dsh-lane\.sh/.test(inside.reason))
    ? true
    : `outside=${JSON.stringify(outside)} sub=${JSON.stringify(outsideSub)} inside=${JSON.stringify(inside)}`;
});
await check('v11 git -C <repo> read-only subcommand is not a write (no deny, no claim)', async () => {
  const repo = claimedRepo();
  await owningSession(repo);
  const b = newAgent({ id: 'session-git-c-read', cwd: NEUTRAL_CWD });
  user(b, '看下另一个仓的提交历史');
  const log = await run(b, 'bash', { command: `git -C ${repo} log --oneline -3` });
  const status = await run(b, 'bash', { command: `git --git-dir ${path.join(repo, '.git')} status --short` });
  const mine = claimsIn(repo).filter((c) => c.sessionId === 'session-git-c-read');
  // Same shape against an UNCLAIMED checkout: a read-only probe must not take a
  // claim either (that is how a browsing session used to lock the real coder out).
  const free = claimedRepo();
  const c = newAgent({ id: 'session-git-c-probe', cwd: NEUTRAL_CWD });
  user(c, '看下这个仓的结构');
  const freeLog = await run(c, 'bash', { command: `git -C ${free} log --oneline -3` });
  const probed = claimsIn(free).filter((line) => line.sessionId === 'session-git-c-probe');
  return (!log.denied && !status.denied && mine.length === 0 && !freeLog.denied && probed.length === 0)
    ? true
    : `log=${JSON.stringify(log)} status=${JSON.stringify(status)} claims=${JSON.stringify(mine)} freeLog=${JSON.stringify(freeLog)} probed=${JSON.stringify(probed)}`;
});
await check('v11 git -C <repo> apply is still denied', async () => {
  const repo = claimedRepo();
  await owningSession(repo);
  const b = newAgent({ id: 'session-git-c-write', cwd: NEUTRAL_CWD });
  user(b, '看下这个补丁');
  const r = await run(b, 'bash', { command: `git -C ${repo} apply fix.diff` });
  return (r.denied && /dsh-lane\.sh/.test(r.reason)) ? true : `reason: ${r.reason}`;
});
await check('v11 &> and &>> name a file destination', async () => {
  const repo = claimedRepo();
  await owningSession(repo);
  const b = newAgent({ id: 'session-amp-redirect', cwd: repo });
  user(b, '记录一下输出');
  const both = await run(b, 'bash', { command: 'echo hi &> both.txt' });
  const append = await run(b, 'bash', { command: 'echo hi &>> both.txt' });
  const outside = await run(b, 'bash', { command: `echo hi &> ${path.join(os.tmpdir(), 'gate-v11-amp.txt')}` });
  return (both.denied && append.denied && !outside.denied)
    ? true
    : `both=${JSON.stringify(both)} append=${JSON.stringify(append)} outside=${JSON.stringify(outside)}`;
});
await check('v11 read-only session leaves no claim entry (mirror-image bug)', async () => {
  const repo = claimedRepo();
  const b = analysisSession(repo, 'session-readonly-noclaim');
  await run(b, 'bash', { command: "python3 - <<'PY'\nprint(1)\nPY" });
  await run(b, 'bash', { command: 'curl -s https://api.example.com/v1/experiments | jq .' });
  await run(b, 'bash', { command: 'git status --short' });
  const mine = claimsIn(repo).filter((c) => c.sessionId === 'session-readonly-noclaim');
  return mine.length === 0 ? true : `read-only session claimed the checkout: ${JSON.stringify(mine)}`;
});
await check('v11 a real in-repo write still claims the checkout (positive control)', async () => {
  const repo = claimedRepo();
  await owningSession(repo, 'session-writer-claims');
  const mine = claimsIn(repo).filter((c) => c.sessionId === 'session-writer-claims');
  return mine.length === 1 ? true : `expected 1 claim line, got ${JSON.stringify(claimsIn(repo))}`;
});
await check('v11 a denied op leaves no claim behind (claim write happens last)', async () => {
  const repo = claimedRepo();
  const b = newAgent({ id: 'session-denied-first', cwd: repo });
  user(b, '修一下配置');
  // denied by skill routing (T1 -> fix-loop); the claim must not be refreshed anyway
  const r = await run(b, 'write', { path: path.join(repo, 'cfg.txt'), content: 'x' });
  const mine = claimsIn(repo).filter((c) => c.sessionId === 'session-denied-first');
  return (r.denied && mine.length === 0) ? true : `denied=${r.denied} claims=${JSON.stringify(mine)}`;
});

// ── P1: ask necessity (only the four hard classes) ──
await check('P1 concrete request: ask_user_question denied (no user-only fact)', async () => {
  const h = newAgent();
  user(h, '把评审和方案收口，按你的判断继续做。');
  const r = await run(h, 'ask_user_question', { questions: [{ id: 'q', question: '继续追生产就绪，还是定成演示可用？' }] });
  return r.denied ? true : 'scope question was allowed on a concrete request';
});
await check('P1 ops authorization ask allowed', async () => {
  const h = newAgent();
  user(h, '把 staging 的 deployment 删掉。');
  const r = await run(h, 'ask_user_question', { questions: [{ id: 'q', question: '确认删除并给出回滚口径？' }] });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('P1 missing-fact ask allowed', async () => {
  const h = newAgent();
  user(h, '用上次说的那个版本重跑一遍。');
  const r = await run(h, 'ask_user_question', { questions: [{ id: 'q', question: '上次说的是哪个版本？' }] });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('P1 taste-only ask allowed', async () => {
  const h = newAgent();
  user(h, '这个页面好看吗？');
  const r = await run(h, 'ask_user_question', { questions: [{ id: 'q', question: '要更专业还是更轻？' }] });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('P1 design freeze confirmation ask allowed', async () => {
  const h = newAgent();
  user(h, '做下架构重构：把采集合并成单容器。');
  skill(h, 'design-orchestrator');
  const r = await run(h, 'ask_user_question', { questions: [{ id: 'q', question: 'L2 设计件已列好，是否确认冻结并开工？' }] });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('P1 design skill loaded but non-freeze scope ask still denied', async () => {
  const h = newAgent();
  user(h, '做下架构重构：把采集合并成单容器。');
  skill(h, 'design-orchestrator');
  const r = await run(h, 'ask_user_question', { questions: [{ id: 'q', question: '要不要顺便把监控也重做？' }] });
  return r.denied ? true : 'scope question allowed under design skill';
});

// ── P1: turn-stop guard (prose question after announced work) ──
const stream = (h, text) => h['agent/assistant-stream']({ frame: { type: 'chunk', chunk: { type: 'text-delta', text } } });
const stop = async (h, steers) => {
  await h['agent/turn-stopping']({ agent: { steer: (m) => steers.push(m) } });
};
await check('P1 announced-work + prose question is steered to continue', async () => {
  const h = newAgent();
  user(h, '回归主线任务，把方案收口。');
  stream(h, 'v4 我按这 7 条改，不再问你。');
  stream(h, '\n\n还是那件只有你能拍：继续追生产就绪，还是定成演示可用？你一句话，我就照那个方向把 v4 定下来。');
  const steers = [];
  await stop(h, steers);
  return steers.length === 1 ? true : `steers=${steers.length}`;
});
await check('P1 plain answer without a question is not steered', async () => {
  const h = newAgent();
  user(h, '把方案收口。');
  stream(h, 'v4 我按这 7 条改，已经改完并复跑通过。');
  const steers = [];
  await stop(h, steers);
  return steers.length === 0 ? true : `steers=${steers.length}`;
});
await check('P1 authorization question is not steered (legit ask)', async () => {
  const h = newAgent();
  user(h, '把 staging 的 deployment 删掉。');
  stream(h, '我按这个方案删，但需要你授权和回滚口径：可以执行吗？');
  const steers = [];
  await stop(h, steers);
  return steers.length === 0 ? true : `steers=${steers.length}`;
});
await check('P1 steer budget is capped at 2 per user turn', async () => {
  const h = newAgent();
  user(h, '回归主线任务。');
  const steers = [];
  for (let i = 0; i < 4; i++) {
    stream(h, '我按这 3 条改。还是那件只有你能拍：A 还是 B？');
    await stop(h, steers);
  }
  return steers.length === 2 ? true : `steers=${steers.length}`;
});
await check('P1 worker subagent is never steered', async () => {
  const h = newAgent({ origin: 'subagent', delegationDepth: 1 });
  user(h, '修复投影链。');
  stream(h, '我按这 3 条改。需要你拍板：A 还是 B？');
  const steers = [];
  await stop(h, steers);
  return steers.length === 0 ? true : `steers=${steers.length}`;
});

// ── P1: design orchestration and no UI false-positive ──
const staleWish = (reason) => /wish-programming/.test(reason || '');
await check('P1 backend "设计优化方案" does not require the UI wish-programming skill', async () => {
  const h = newAgent();
  user(h, '你来设计优化方案，然后优化，然后验证；理解每个模块的真实含义和价值来设计');
  const r = await run(h, 'write', { path: 'src/ingest.py', content: 'x' });
  return r.denied && staleWish(r.reason) ? `wrong reason: ${r.reason}` : true;
});
await check('P1 architecture redesign routes to design-orchestrator', async () => {
  const h = newAgent();
  user(h, '做下架构重构吧，干掉这些补丁');
  const r = await run(h, 'write', { path: 'src/ingest.py', content: 'x' });
  return r.denied && /design-orchestrator/.test(r.reason) ? true : `reason: ${r.reason}`;
});
await check('P1 domain design skill alone cannot bypass design orchestration', async () => {
  const h = newAgent();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gatep1-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  user(h, '做下架构重构：把采集容器合并成单容器');
  skill(h, 'architecture-design');
  const r = await run(h, 'write', { path: path.join(repo, 'src', 'app.py'), content: 'x' });
  return r.denied && /design-orchestrator|freeze/.test(r.reason) ? true : `reason: ${r.reason}`;
});
await check('P1 orchestrator started: implementation blocked until freeze.md exists', async () => {
  const h = newAgent();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gatep1c-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  user(h, '做下架构重构：把采集容器合并成单容器');
  skill(h, 'design-orchestrator');
  const design = await run(h, 'write', { path: path.join(repo, 'docs', 'design', 'ingest', 'arch.md'), content: 'x' });
  const impl = await run(h, 'write', { path: path.join(repo, 'src', 'app.py'), content: 'x' });
  return (!design.denied && impl.denied && /freeze\.md/.test(impl.reason)) ? true : `design=${JSON.stringify(design)} impl=${JSON.stringify(impl)}`;
});
await check('P1 orchestrator + frozen design allows implementation', async () => {
  const h = newAgent();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gatep1b-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs', 'design', 'ingest'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'design', 'ingest', 'freeze.md'), 'version v1\n');
  user(h, '做下架构重构：把采集容器合并成单容器');
  skill(h, 'design-orchestrator');
  const r = await run(h, 'write', { path: path.join(repo, 'src', 'app.py'), content: 'x' });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('P1 design artifact write still requires orchestrator', async () => {
  const h = newAgent();
  user(h, '写一份产品设计：订单筛选');
  const r = await run(h, 'write', { path: 'docs/design/orders/product.md', content: 'x' });
  return r.denied && /design-orchestrator/.test(r.reason) ? true : JSON.stringify(r);
});

// ── P1: ask budget ──
await check('P1 second ask in the same user turn is denied', async () => {
  const h = newAgent();
  user(h, '评估一下这个设计文档能不能逐步完成');
  const a = await run(h, 'ask_user_question', { questions: [{ id: 'a', question: 'a' }] });
  askResult(h, '按 A 做');
  const b = await run(h, 'ask_user_question', { questions: [{ id: 'b', question: 'b' }] });
  return (!a.denied && b.denied) ? true : `first=${JSON.stringify(a)} second=${JSON.stringify(b)}`;
});
await check('P1 ask allowed again after a new user message', async () => {
  const h = newAgent();
  user(h, '评估这个设计');
  await run(h, 'ask_user_question', { questions: [{ id: 'a', question: 'a' }] });
  askResult(h, '先做 A');
  user(h, '继续');
  const r = await run(h, 'ask_user_question', { questions: [{ id: 'b', question: 'b' }] });
  return r.denied ? `denied: ${r.reason}` : true;
});

// ── P1/P2: unknown skill must not be silently swallowed ──
await check('P1 failed skill load forces one surfacing before more writes', async () => {
  const h = newAgent();
  user(h, '按 spec 包拆分任务');
  skill(h, 'spec', false);
  const r = await run(h, 'write', { path: 'docs/spec.md', content: 'x' });
  if (!r.denied) return 'write continued after unknown skill';
  const r2 = await run(h, 'write', { path: 'docs/spec.md', content: 'x' });
  return r2.denied ? 'still denied after surfacing (no recovery)' : true;
});

// ── regression: existing contract kept ──
await check('R0 unrequested git push denied', async () => {
  const h = newAgent();
  user(h, '改完就行，不用提交。');
  const r = await run(h, 'bash', { command: 'git push origin main' });
  return r.denied ? true : 'unrequested push allowed';
});
await check('R0 domain skill load is never hard-blocked', async () => {
  const h = newAgent();
  user(h, '订单筛选怎么设计');
  const r = await run(h, 'skill', { name: 'tech-selection' });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('R0 design artifact write is exempt from the freeze gate', async () => {
  const h = newAgent();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gatep1d-'));
  user(h, '写一份设计件');
  skill(h, 'design-orchestrator');
  const r = await run(h, 'write', { path: path.join(repo, 'docs', 'design', 'x', 'design.md'), content: 'x' });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('R1 T1 edit needs fix-loop then allowed', async () => {
  const h = newAgent();
  user(h, '把 test_orders 修绿。');
  const a = await run(h, 'edit', { path: 'tests/test_orders.py', old: 'a', new: 'b' });
  skill(h, 'fix-loop');
  const b = await run(h, 'edit', { path: 'tests/test_orders.py', old: 'a', new: 'b' });
  return (a.denied && /fix-loop/.test(a.reason) && !b.denied) ? true : `${JSON.stringify(a)} ${JSON.stringify(b)}`;
});
await check('R2 bare git worktree denied, lane hint given', async () => {
  const h = newAgent();
  user(h, '两个任务并行改同一个仓');
  const r = await run(h, 'bash', { command: 'git worktree add ../x task/a' });
  return r.denied && /dsh-lane/.test(r.reason) ? true : JSON.stringify(r);
});
await check('R3 ordinary write unaffected', async () => {
  const h = newAgent();
  user(h, '写一个普通说明文件');
  const r = await run(h, 'write', { path: 'notes.txt', content: 'x' });
  return r.denied ? `denied: ${r.reason}` : true;
});
await check('R4 ops-flavoured complete request asks once, then allows', async () => {
  const h = newAgent();
  user(h, '把 nginx conf 切到新版本，然后重启。');
  const a = await run(h, 'write', { path: 'nginx.conf', content: 'x' });
  await run(h, 'ask_user_question', { questions: [{ id: 'q', question: '授权？' }] });
  askResult(h, '授权，回滚就是 git checkout 这份 conf');
  skill(h, 'change-spec');
  const b = await run(h, 'write', { path: 'nginx.conf', content: 'x' });
  return (a.denied && !b.denied) ? true : `${JSON.stringify(a)} ${JSON.stringify(b)}`;
});

console.log(out.join('\n'));
console.log(fail ? `RESULT ${ok} pass, ${fail} fail` : `RESULT ${ok} pass, 0 fail`);
process.exit(fail ? 1 : 0);