/**
 * 飞书设置页的本地字典（连接向导 + 命名空间配置表单）。
 *
 * 家族设置卡已移除，向导与配置页自带一份最小字典，不依赖设置位置的 locale
 * 命名空间。zh 是键集来源，en 必须保持同一键集。
 */

export const zh = {
  'settings.tab': '飞书',
  'settings.title': '飞书连接与配置',
  'settings.intro': '连接飞书机器人，并调整事件进入会话的方式。凭据由上方向导写入，不在此显示。',
  'settings.summary': '连接飞书机器人并配置事件投递。',
  'settings.enabled': '启用飞书接入',
  'settings.enabledHint': '关闭后不再建立长连接，已有事件保留在队列中。',
  'settings.announce': '在系统提示中告知 Agent',
  'settings.announceHint': '开启后当前会话会收到一段飞书事件使用说明。',
  'settings.domain': '开放平台域名',
  'settings.domainHint': 'feishu（飞书）或 lark（Lark 国际版）。留空使用默认值 feishu。',
  'settings.requireMention': '群聊需 @ 机器人',
  'settings.requireMentionHint': '关闭后群里的所有消息都会进入队列。',
  'settings.allowedOpenIds': '允许的发送者 open_id',
  'settings.allowedOpenIdsHint': '一行一个（也支持逗号/分号分隔）。留空表示不限制发送者。',
  'settings.queueDir': '事件队列目录',
  'settings.queueDirHint': '存放待处理事件的目录。留空使用插件默认目录。',
  'settings.maxAttempts': '最大投递尝试次数',
  'settings.maxAttemptsHint': '单条事件失败后最多重试几次。留空使用默认值。',
  'settings.staleTimeout': '过期超时（毫秒）',
  'settings.staleTimeoutHint': '事件超过该时长仍未处理则视为过期。留空使用默认值。',
  'settings.save': '保存',
  'settings.saving': '保存中…',
  'settings.saveFailed': '本部署没有接受这些值，已保留供你修改。',
  'settings.readOnly': '本部署的设置为只读。',
  'settings.unavailable': '宿主当前未提供飞书配置，暂时无法编辑。',
  'settings.overridden': '已覆盖',
  'settings.reset': '恢复默认',
  'settings.invalid': '该值不被接受，请修改或清空以恢复默认。',
  'settings.invalidNumber': '请填数字；留空表示使用默认值。',
  'wizard.createNew': '创建新 bot',
  'wizard.bindExisting': '绑定已有 bot',
  'wizard.appId': 'App ID',
  'wizard.appIdHint': '飞书开放平台应用的 App ID。',
  'wizard.appSecret': 'App Secret',
  'wizard.appSecretHint': '应用的 App Secret，仅用于本次绑定，不会写入日志。',
  'wizard.confirmBind': '确认绑定',
  'wizard.finishBind': '完成绑定',
  'wizard.openLinkHint': '打开授权链接：',
  'wizard.awaitingHint': '请在飞书中完成授权，页面每 2 秒自动刷新状态。',
  'wizard.openConsoleHint': '打开开放平台后台，确认应用并复制 App Secret：',
  'wizard.qrAlt': '飞书授权二维码',
  'wizard.connected': '已连接 {appId}',
  'wizard.connectedHint': '凭据已就绪，飞书事件将进入当前会话。',
  'wizard.needsSecretHint': '应用已创建，请在下方 App Secret 字段粘贴一次密钥后保存。',
  'wizard.cancel': '取消',
  'wizard.back': '返回',
  'wizard.failed': '连接失败',
  'wizard.installHint': '若尚未安装 lark-cli，请先在命令行安装并登录，然后重试。',
  'wizard.busy': '处理中…',
} as const

export type LarkKey = keyof typeof zh

export const en: Record<LarkKey, string> = {
  'settings.tab': 'Feishu',
  'settings.title': 'Feishu connection and settings',
  'settings.intro': 'Connect the Feishu bot and control how its events reach the session. Credentials are written by the wizard above and never shown here.',
  'settings.summary': 'Connect the Feishu bot and configure event delivery.',
  'settings.enabled': 'Enable Feishu intake',
  'settings.enabledHint': 'When off, the long connection is not opened and queued events stay in the queue.',
  'settings.announce': 'Tell the agent about Feishu events',
  'settings.announceHint': 'When on, the current session receives a short guide for Feishu events.',
  'settings.domain': 'Open platform domain',
  'settings.domainHint': 'feishu or lark. Leave blank to use the default (feishu).',
  'settings.requireMention': 'Groups require an @mention',
  'settings.requireMentionHint': 'When off, every group message enters the queue.',
  'settings.allowedOpenIds': 'Allowed sender open_ids',
  'settings.allowedOpenIdsHint': 'One per line (comma or semicolon also works). Leave blank to accept every sender.',
  'settings.queueDir': 'Event queue directory',
  'settings.queueDirHint': 'Directory holding pending events. Leave blank for the plugin default.',
  'settings.maxAttempts': 'Maximum delivery attempts',
  'settings.maxAttemptsHint': 'How many times one event may be retried. Leave blank for the default.',
  'settings.staleTimeout': 'Stale timeout (ms)',
  'settings.staleTimeoutHint': 'An event older than this is treated as stale. Leave blank for the default.',
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.saveFailed': 'The deployment did not accept these values; they were left for you to correct.',
  'settings.readOnly': 'This deployment stores settings read-only.',
  'settings.unavailable': 'The host does not serve Feishu settings right now, so they cannot be edited.',
  'settings.overridden': 'Overridden',
  'settings.reset': 'Reset to default',
  'settings.invalid': 'This value is not accepted; change it or clear it to use the default.',
  'settings.invalidNumber': 'Enter a number, or leave blank to use the default.',
  'wizard.createNew': 'Create new bot',
  'wizard.bindExisting': 'Bind existing bot',
  'wizard.appId': 'App ID',
  'wizard.appIdHint': 'The App ID of the Feishu Open Platform application.',
  'wizard.appSecret': 'App Secret',
  'wizard.appSecretHint': "The app's App Secret, used only for this bind and never written to logs.",
  'wizard.confirmBind': 'Confirm bind',
  'wizard.finishBind': 'Finish bind',
  'wizard.openLinkHint': 'Open the authorization link: ',
  'wizard.awaitingHint': 'Complete the authorization in Feishu; this page refreshes status every 2 seconds.',
  'wizard.openConsoleHint': 'Open the Open Platform console, confirm the app, and copy the App Secret: ',
  'wizard.qrAlt': 'Feishu authorization QR code',
  'wizard.connected': 'Connected {appId}',
  'wizard.connectedHint': 'Credentials are ready; Feishu events will arrive in the current session.',
  'wizard.needsSecretHint': 'The app was created; paste its secret once into the App Secret field below and save.',
  'wizard.cancel': 'Cancel',
  'wizard.back': 'Back',
  'wizard.failed': 'Connection failed',
  'wizard.installHint': 'If lark-cli is not installed yet, install and log in from the command line, then retry.',
  'wizard.busy': 'Working…',
}

export type Translate = (key: LarkKey, params?: Record<string, string | number>) => string

/** 取字典：`<html lang>` 以 zh 开头用中文，否则英文。 */
export function makeT(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): Translate {
  const lang = doc?.documentElement?.lang?.toLowerCase() ?? ''
  const table: Record<LarkKey, string> = lang.startsWith('zh') ? zh : en
  return (key, params) => {
    const text = table[key] ?? key
    if (params === undefined) return text
    return text.replace(/\{(\w+)\}/gu, (match, name: string) => params[name] === undefined ? match : String(params[name]))
  }
}