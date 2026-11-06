/**
 * 外援会话展示面 copy：zh 是键集来源，en 必须保持同一键集（由类型强制）。
 *
 * 与右栏/SSH 面板同一套约定：位置模块注册一个 locale 命名空间，面板与下拉
 * 分组共用它；测试直接拿 zh 当 t()。
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** 本能力使用的 locale 命名空间。 */
export const NS = 'web-all-external-session'

export const zh = {
  'tab.title': '外援会话',
  'tab.description': '外部 CLI（Claude Code / Codex）的续接会话与轮次记录',

  'panel.title': '外援会话',
  'panel.intro': '每轮是一次外部 CLI 子进程；可带会话接续追问。',
  'panel.count': '{count} 个会话',
  'panel.refresh': '刷新',
  'panel.loading': '正在读取外援会话…',

  'list.title': '会话',
  'list.empty': '还没有外援会话。让 agent 用 subagent_claude_code 或 subagent_codex 跑一轮后，这里会出现记录。',

  'session.meta': '{provider} · {status} · {time}',
  'session.noTime': '未运行',

  'status.running': '运行中',
  'status.idle': '空闲',
  'status.failed': '失败',
  'status.closed': '已关闭',

  'timeline.title': '轮次',
  'timeline.empty': '还没有轮次记录。',
  'timeline.number': '第 {n} 轮',
  'timeline.prompt': '输入',
  'timeline.result': '结果',
  'timeline.noResult': '这一轮没有回结果文本。',
  'timeline.duration': '耗时 {duration}',
  'timeline.usage': '用量 {input} 入 / {output} 出',
  'timeline.cost': '估算 {cost}',

  'turn.status.running': '进行中',
  'turn.status.completed': '已完成',
  'turn.status.failed': '失败',
  'turn.status.aborted': '已取消',

  'action.continue': '追问',
  'action.continuePlaceholder': '向这个会话派下一轮…',
  'action.continueLabel': '下一轮的内容',
  'action.sending': '派发中…',
  'action.cancel': '取消本轮',
  'action.cancelling': '取消中…',
  'action.close': '关闭会话',
  'action.closing': '关闭中…',
  'action.retry': '重试',

  'blocked.closed': '会话已关闭，不能再派轮次。',
  'blocked.unresumable': '缺少 CLI 会话号，这一轮只能新建会话重跑。',

  'state.forbidden': '宿主拒绝了这次请求（403）：当前页面没有外援会话的访问权限。',
  'state.unavailable': '宿主还没有提供外援会话路由（能力未启用或版本不含它）。',
  'state.failed': '读取外援会话失败：{message}',
  'state.emptyTurn': '还没有会话可选。',

  'fail.cwd-invalid': '工作目录不存在或不可进入，换一个 cwd 再派。',
  'fail.session-unknown': '这个外援会话不在存储里（可能已被删除）。',
  'fail.session-closed': '会话已关闭，不能再派轮次。',
  'fail.session-unresumable': '缺少 CLI 会话号，这一轮无法接续，只能新建会话。',
  'fail.busy': '并发已满：全局上限已到，或这个会话正在跑另一轮。',
  'fail.limit': '外援会话记录数已达上限，先关闭或删除旧会话。',
  'fail.auth-required': '外部 CLI 未登录或缺凭据，先在 CLI 自己的设置里补上。',
  'fail.provider-missing': '宿主上找不到对应的外部 CLI 可执行文件。',
  'fail.provider-error': '这一轮外部 CLI 报错，详情见该轮结果。',

  'group.title': '外援 · {count}',
  'group.tag': '外部任务',
  'group.empty': '还没有外援会话',
  'group.openAria': '打开外援会话「{title}」',
  'group.state.running': '运行中 {elapsed}',
  'group.state.runningIdle': '运行中 {elapsed} · 静默 {idle}',
  'group.state.failed': '失败',
  'group.state.closed': '已关闭',
  'group.state.partial': '部分结果',
  'scoped.all': '全部会话',
  'scoped.other': '其它会话',
  'scoped.unknown': '来源未知',
} as const

/** 键集。 */
export type ExternalSessionLocaleKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'web-all-external-session': ExternalSessionLocaleKey }
}

/** en 必须覆盖同一键集。 */
export const en: Record<ExternalSessionLocaleKey, string> = {
  'tab.title': 'External sessions',
  'tab.description': 'Continued sessions and turn records from external CLIs (Claude Code / Codex)',

  'panel.title': 'External sessions',
  'panel.intro': 'Each turn is one external CLI subprocess; a session can be continued.',
  'panel.count': '{count} sessions',
  'panel.refresh': 'Refresh',
  'panel.loading': 'Reading external sessions…',

  'list.title': 'Sessions',
  'list.empty': 'No external sessions yet. After the agent runs one turn through subagent_claude_code or subagent_codex, the record appears here.',

  'session.meta': '{provider} · {status} · {time}',
  'session.noTime': 'never ran',

  'status.running': 'running',
  'status.idle': 'idle',
  'status.failed': 'failed',
  'status.closed': 'closed',

  'timeline.title': 'Turns',
  'timeline.empty': 'No turns recorded yet.',
  'timeline.number': 'Turn {n}',
  'timeline.prompt': 'Input',
  'timeline.result': 'Result',
  'timeline.noResult': 'This turn returned no result text.',
  'timeline.duration': '{duration}',
  'timeline.usage': '{input} in / {output} out',
  'timeline.cost': 'estimated {cost}',

  'turn.status.running': 'running',
  'turn.status.completed': 'completed',
  'turn.status.failed': 'failed',
  'turn.status.aborted': 'cancelled',

  'action.continue': 'Continue',
  'action.continuePlaceholder': 'What should this session do next…',
  'action.continueLabel': 'Next turn prompt',
  'action.sending': 'Sending…',
  'action.cancel': 'Cancel turn',
  'action.cancelling': 'Cancelling…',
  'action.close': 'Close session',
  'action.closing': 'Closing…',
  'action.retry': 'Retry',

  'blocked.closed': 'The session is closed and takes no further turns.',
  'blocked.unresumable': 'No CLI session id was recorded, so this turn cannot be continued; start a new session instead.',

  'state.forbidden': 'The host refused this request (403): this page has no access to external sessions.',
  'state.unavailable': 'The host does not expose external-session routes (capability disabled or absent in this version).',
  'state.failed': 'Reading external sessions failed: {message}',
  'state.emptyTurn': 'No session selected yet.',

  'fail.cwd-invalid': 'The working directory is missing or not enterable; send the turn with another cwd.',
  'fail.session-unknown': 'This external session is not in storage (it may have been deleted).',
  'fail.session-closed': 'The session is closed and takes no further turns.',
  'fail.session-unresumable': 'No CLI session id was recorded, so this session cannot be continued; start a new one.',
  'fail.busy': 'Concurrency is full: either the global limit is reached or this session is already running a turn.',
  'fail.limit': 'The external session limit is reached; close or delete old sessions first.',
  'fail.auth-required': 'The external CLI is not signed in or lacks credentials; set them in the CLI own settings first.',
  'fail.provider-missing': 'The host cannot find the external CLI executable.',
  'fail.provider-error': 'This turn reported an external CLI error; see the turn result for details.',

  'group.title': 'External · {count}',
  'group.tag': 'external task',
  'group.empty': 'No external sessions',
  'group.openAria': 'Open external session “{title}”',
  'group.state.running': 'running {elapsed}',
  'group.state.runningIdle': 'running {elapsed} · quiet {idle}',
  'group.state.failed': 'failed',
  'group.state.closed': 'closed',
  'group.state.partial': 'partial result',
  'scoped.all': 'all conversations',
  'scoped.other': 'other conversation',
  'scoped.unknown': 'origin unknown',
}

/** 按 `{name}` 占位符插值；缺失的参数原样留空，不抛错。 */
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (_match, name: string) => String(params[name] ?? ''))
}