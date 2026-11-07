// turn-contract — code-vibe preset's narrow runtime contract for launch/close turns.
//
// Why it exists: after `wish-gate` was removed (2026-11-02) the preset kept all of
// its discipline rules but lost the only layer that could make a rule bind at
// runtime. A launch-readiness question then gets answered with a prose debt list
// ("生产还在跑旧代码 / 没有回滚演练") because nothing requires the mechanical gate
// first — observed live on 2026-11-08 with the question 「具备全量上线的条件了吗」.
//
// Scope is deliberately one rule, one direction:
//   - the user's OWN message asks a launch/close question;
//   - the turn has not executed `release_check.py`;
//   - the turn is about to stop (agent/turn-stopping);
//   -> steer the turn ONCE with the exact command, so the answer becomes a gate
//      table instead of an opinion.
//
// It never denies a tool, never claims a checkout, never writes into a user
// repository and never asks the user a question. Those are the four reasons the
// old gate was removed; none of them is in scope here. A miss costs one steering
// message, not a wedged session.
//
// Activation boundary: this module is loaded from the package subpath by the
// preset composition, and module code is ESM-cached per process — a new row or an
// edit here becomes live only after the DSH profile is reassembled (restart).

// Topic + ask marker, not a phrase list: users phrase this every way ("具备全量
// 上线的条件了吗", "发布前检查有什么问题", "上生产还差什么", "能收尾吗").
const TOPIC_RE = /(上线|发布|发版|上生产|发了|发出去|rollout|收尾|关版)/iu
const ASK_RE = /(吗|呢|？|\?|条件|还差|准备|能否|可以|是否|够不|问题|检查|没做完|验收)/iu
const NEGATED_RE = /(不用|不要|别|先不|暂不|不需要)\s*[^。；\n]{0,12}(上线|发布|发版|收尾)/iu
const GATE_COMMAND_RE = /release_check\.py/iu

export const name = 'turn-contract'

/** True when the user's own message is a launch-readiness or close-out question. */
export function isLaunchQuestion(text) {
  if (typeof text !== 'string' || !text.trim()) return false
  if (NEGATED_RE.test(text)) return false
  return TOPIC_RE.test(text) && ASK_RE.test(text)
}

/** True when a bash command string runs the release gate. */
export function runsReleaseGate(command) {
  return typeof command === 'string' && GATE_COMMAND_RE.test(command)
}

/** The steering decision, kept pure so it can be tested without a runtime. */
export function shouldSteer(state) {
  if (!state) return false
  return Boolean(state.launchTurn && !state.gateRan && state.steers < 1)
}

/** The steering text: one command, one format rule, one anti-excuse rule. */
export function steerText() {
  return [
    '【turn-contract】这一轮用户问的是上线 / 收尾判定，而本轮还没有执行发布门。先用 release-gate 的命令拿读数，再回答：',
    'python3 <preset>/skills/wish-programming/scripts/release_check.py <workspace> <id> --run',
    '把它的 PASS/FAIL 表整段贴出来；表就是答案。发布方案 .sdd/release/<id>.env 不存在时，先写 P2 发布方案 + P3 验证方案再跑。',
    '禁止用散文结论代替表；「代码没 push / 没构建 / 没部署 / 没有 E2E / 没有回滚点」是我们自己的欠账，不是外部阻断。',
  ].join('\n')
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && typeof part === 'object' && part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')
}

function commandOf(args) {
  let parsed = args
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args)
    } catch {
      return args
    }
  }
  if (!parsed || typeof parsed !== 'object') return ''
  return parsed.command ?? parsed.cmd ?? parsed.script ?? ''
}

function isSubagent(agent) {
  try {
    const header = agent?.session?.header
    if (header && (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0)) return true
  } catch {
    // A header that cannot be read is not a subagent; the worst case is one
    // steering message inside a delegation, which is harmless.
  }
  return false
}

function steerMessage() {
  return {
    id: `turn-contract-${Date.now().toString(36)}`,
    role: 'user',
    content: [{ type: 'text', text: steerText() }],
    source: { kind: 'turn-contract' },
  }
}

export function apply(ctx) {
  if (process.env.TURN_CONTRACT_STEER === '0') return
  ctx.on('agent/created', ({ agent }) => {
    const state = { launchTurn: false, gateRan: false, steers: 0 }
    const disposers = []

    disposers.push(agent.ctx.on('agent/inbox/claimed', ({ message }) => {
      if (message?.source?.kind !== 'user') return
      state.launchTurn = isLaunchQuestion(textOf(message.content))
      state.gateRan = false
      state.steers = 0
    }))

    disposers.push(agent.ctx.on('tools/result', (exec) => {
      const tool = exec?.name
      if (tool !== 'bash' && tool !== 'pwsh') return
      if (runsReleaseGate(commandOf(exec.arguments))) state.gateRan = true
    }))

    disposers.push(agent.ctx.on('agent/turn-stopping', ({ agent: who }) => {
      if (!shouldSteer(state)) return
      if (isSubagent(who)) return
      state.steers += 1
      try {
        who.steer(steerMessage())
      } catch {
        try {
          who.steer({ ...steerMessage(), source: { kind: 'user' } })
        } catch {
          // A steering failure must never break the turn; the user still sees it.
        }
      }
    }))

    disposers.push(agent.ctx.on('agent/disposed', () => {
      for (const off of disposers) off()
    }))
  })
}

export default { name, apply }