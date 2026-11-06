/**
 * 记忆面板的界面文案：`zh` 是 key 源，`en` 逐键对照。
 *
 * `tt()` 与 SSH 面板同一套做法：按 `<html lang>` 在调用时刻选字典，因此切换
 * 界面语言不需要重建面板；同时把两份字典经位置模块注册到 locale 服务
 * （`web-all-memory`），框架侧的语言切换也能看到这套 key。
 *
 * 组件里不写任何可见文案，也不读错误体的 `message`：失败一律按
 * `MemoryErrorCode` 选上面 `error.*` 的 key（wire 契约要求按码决定文案）。
 */
import type { MemoryErrorCode } from '../../../../core/memory-view/protocol.ts'

/** locale 服务里的命名空间。 */
export const MEMORY_PANEL_LOCALE = 'web-all-memory' as const

export const zh = {
  'entry.label': '记忆',
  'panel.title': '记忆',
  'panel.intro': '只读查看 OpenViking 记忆：全局空间与当前工作区，支持目录浏览与全文检索。',
  'panel.refresh': '刷新',
  'tab.global': '全局',
  'tab.workspace': '工作区',
  'common.loading': '正在加载…',
  'common.retry': '重试',
  'error.notConfigured': '尚未配置 OpenViking 连接。',
  'error.unreachable': '无法连接 OpenViking 服务。',
  'error.unauthorized': 'OpenViking 拒绝了访问授权。',
  'error.malformed': 'OpenViking 返回了本页无法解析的响应。',
  'error.forbidden': '当前页面无权访问记忆接口。',
  'error.notFound': '这条记忆已不存在。',
  'error.internal': 'OpenViking 服务内部出错。',
  'status.disconnected': '未连接到 OpenViking（{server}）。',
  'workspace.peer': '工作区 peer：{peer}',
  'workspace.noCwd': '没有解析到当前工作区：请在左侧打开一个工作区会话。',
  'workspace.noPeer': '当前工作区不在 git 仓库内，记忆落在全局空间。',
  'workspace.openGlobal': '查看全局',
  'workspace.source.gitRemote': '来自 git remote',
  'workspace.source.gitRoot': '来自仓库根路径',
  'workspace.source.none': '不在 git 仓库内',
  'workspace.source.unknown': '未能判断',
  'crumb.label': '记忆路径',
  'list.empty': '这个目录里还没有记忆。',
  'list.directory': '目录',
  'list.backToRoot': '返回根目录',
  'size.bytes': '{value} B',
  'size.kib': '{value} KB',
  'size.mib': '{value} MB',
  'size.gib': '{value} GB',
  'search.label': '检索记忆',
  'search.placeholder': '搜索标题与正文…',
  'search.submit': '搜索',
  'search.clear': '清除',
  'search.empty': '没有匹配的记忆。',
  'search.results': '检索结果（{count} 条）',
  'search.score': '相关度 {score}',
  'preview.title': '记忆内容',
  'preview.close': '关闭预览',
}

/** 英文对照：键集必须与 `zh` 完全一致。 */
export const en: Record<MemoryKey, string> = {
  'entry.label': 'Memory',
  'panel.title': 'Memory',
  'panel.intro': 'Read-only view of OpenViking memory: the global space and the current workspace, with directory browsing and full-text search.',
  'panel.refresh': 'Refresh',
  'tab.global': 'Global',
  'tab.workspace': 'Workspace',
  'common.loading': 'Loading…',
  'common.retry': 'Retry',
  'error.notConfigured': 'OpenViking is not configured yet.',
  'error.unreachable': 'Cannot reach the OpenViking service.',
  'error.unauthorized': 'OpenViking refused the authorization.',
  'error.malformed': 'OpenViking returned a response this page cannot read.',
  'error.forbidden': 'This page may not call the memory API.',
  'error.notFound': 'That memory no longer exists.',
  'error.internal': 'The OpenViking service failed internally.',
  'status.disconnected': 'Not connected to OpenViking ({server}).',
  'workspace.peer': 'Workspace peer: {peer}',
  'workspace.noCwd': 'No current workspace detected. Open a workspace session on the left.',
  'workspace.noPeer': 'This workspace is not a git repository, so memory lives in the global space.',
  'workspace.openGlobal': 'View global',
  'workspace.source.gitRemote': 'from the git remote',
  'workspace.source.gitRoot': 'from the repository root path',
  'workspace.source.none': 'not inside a git repository',
  'workspace.source.unknown': 'could not be determined',
  'crumb.label': 'Memory path',
  'list.empty': 'No memory in this directory yet.',
  'list.directory': 'Directory',
  'list.backToRoot': 'Back to root',
  'size.bytes': '{value} B',
  'size.kib': '{value} KB',
  'size.mib': '{value} MB',
  'size.gib': '{value} GB',
  'search.label': 'Search memory',
  'search.placeholder': 'Search titles and content…',
  'search.submit': 'Search',
  'search.clear': 'Clear',
  'search.empty': 'No memory matched.',
  'search.results': 'Results ({count})',
  'search.score': 'relevance {score}',
  'preview.title': 'Memory document',
  'preview.close': 'Close preview',
}

/** 文案 key 联合类型（`zh` 是 key 源）。 */
export type MemoryKey = keyof typeof zh

/** 模板取值：只接受标量，避免把对象插进文案。 */
export type MemoryValues = Record<string, string | number>

/** 当前生效的字典，按文档语言在调用时刻选取。 */
export function dictionary(): Record<string, string> {
  const lang = typeof document === 'undefined' ? 'zh' : document.documentElement.lang
  return lang.toLowerCase().startsWith('en') ? { ...en } : { ...zh }
}

/** 取一条文案并替换 `{name}` 占位符。 */
export function t(source: Record<string, string>, key: string, values?: MemoryValues): string {
  let text = source[key] ?? key
  if (values !== undefined) {
    for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

/** 当前语言下的一条文案（组件里唯一的取词入口）。 */
export function tt(key: MemoryKey, values?: MemoryValues): string {
  return t(dictionary(), key, values)
}

/** 失败码到文案 key 的映射：客户端只按码选文案，不解析服务端 message。 */
const ERROR_KEYS: Record<MemoryErrorCode, MemoryKey> = {
  'not-configured': 'error.notConfigured',
  unreachable: 'error.unreachable',
  unauthorized: 'error.unauthorized',
  malformed: 'error.malformed',
  forbidden: 'error.forbidden',
  'not-found': 'error.notFound',
  internal: 'error.internal',
}

/** 失败码的可读文案。 */
export function errorText(code: MemoryErrorCode): string {
  return tt(ERROR_KEYS[code])
}

/**
 * 把命名空间并进 locale 服务的 key 联合：`ctx.locale.register('web-all-memory', …)`
 * 因此会在编译期被逐键校验（zh/en 都必须是完整键集）。
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'web-all-memory': MemoryKey
  }
}
