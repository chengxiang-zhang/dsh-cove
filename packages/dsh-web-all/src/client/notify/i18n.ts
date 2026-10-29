/**
 * 通知设置页的本地字典（飞书推送配置）。
 *
 * 与飞书设置页同一套约定：zh 是键集来源，en 必须保持同一键集；页面自带字典，
 * 不依赖设置位置的 locale 命名空间。
 */

export const zh = {
  'settings.tab': '通知',
  'settings.title': '运行结束通知',
  'settings.intro': '会话运行结束后，把结果推送到飞书，并让桌面端与手机端的机器列表标出未查看的结果。',
  'settings.summary': '运行结束后推送到飞书，并在机器列表标出未查看的结果。',
  'settings.enabled': '启用通知',
  'settings.enabledHint': '关闭后不记录运行结果，机器列表也不再显示未查看标记；已记录的结果会被清空。',
  'settings.feedLimit': '单次读取返回条数',
  'settings.feedLimitHint': '客户端一次拉取最多拿到多少条结果。留空使用默认值 20。',
  'settings.feishuEnabled': '推送到飞书',
  'settings.feishuEnabledHint': '开启后，运行结束会由机器人发送消息给你。需要下面填好应用凭据与收件人。',
  'settings.feishuAppId': '飞书 App ID',
  'settings.feishuAppIdHint': '留空则沿用「飞书」页配置的机器人应用。',
  'settings.feishuAppSecret': '飞书 App Secret',
  'settings.feishuAppSecretHint': '可填 env:变量名 从环境变量读取。留空则沿用「飞书」页配置的应用。',
  'settings.feishuDomain': '开放平台域名',
  'settings.feishuDomainHint': 'feishu（飞书）或 lark（Lark 国际版）。留空使用默认值 feishu。',
  'settings.feishuRecipients': '收件人',
  'settings.feishuRecipientsHint': '一行一个 open_id（ou_ 开头）或 chat_id（oc_ 开头）。留空表示不推送。',
  'settings.feishuMode': '推送时机',
  'settings.feishuModeHint': 'idle：等这一轮工作彻底停下后合并成一条；each-turn：每结束一轮就发一条。留空使用默认值 idle。',
  'settings.feishuOutcomes': '推送哪些结果',
  'settings.feishuOutcomesHint': '一行一个：completed（已完成）、failed（出错）、stopped（已结束）。留空使用默认值 completed 与 failed。',
  'settings.save': '保存',
  'settings.saving': '保存中…',
  'settings.saveFailed': '本部署没有接受这些值，已保留供你修改。',
  'settings.readOnly': '本部署的设置为只读。',
  'settings.unavailable': '宿主当前未提供通知配置，暂时无法编辑。',
  'settings.overridden': '已覆盖',
  'settings.reset': '恢复默认',
  'settings.invalid': '该值不被接受，请修改或清空以恢复默认。',
  'settings.invalidNumber': '请填数字；留空表示使用默认值。',
  'settings.feed': '客户端读取地址',
  'settings.feedHint': '桌面端与手机端按这个地址拉取运行结果；它只读，且需要本机或已声明入口的访问权限。',
} as const

export type NotifyKey = keyof typeof zh

export const en: Record<NotifyKey, string> = {
  'settings.tab': 'Notifications',
  'settings.title': 'Run-finished notifications',
  'settings.intro': 'When a session finishes running, push the result to Feishu and mark the unseen results in the desktop and mobile machine lists.',
  'settings.summary': 'Push finished runs to Feishu and mark unseen results in the machine list.',
  'settings.enabled': 'Enable notifications',
  'settings.enabledHint': 'When off, run results are not recorded and the machine list stops marking unseen ones; already recorded results are dropped.',
  'settings.feedLimit': 'Notices per read',
  'settings.feedLimitHint': 'How many results a client receives in one pull. Leave blank to use the default of 20.',
  'settings.feishuEnabled': 'Push to Feishu',
  'settings.feishuEnabledHint': 'When on, the bot messages you when a run finishes. Requires the credentials and recipients below.',
  'settings.feishuAppId': 'Feishu App ID',
  'settings.feishuAppIdHint': 'Leave blank to reuse the bot configured on the Feishu page.',
  'settings.feishuAppSecret': 'Feishu App Secret',
  'settings.feishuAppSecretHint': 'Accepts env:NAME to read an environment variable. Leave blank to reuse the application configured on the Feishu page.',
  'settings.feishuDomain': 'Open platform domain',
  'settings.feishuDomainHint': 'feishu or lark. Leave blank to use the default (feishu).',
  'settings.feishuRecipients': 'Recipients',
  'settings.feishuRecipientsHint': 'One open_id (starts with ou_) or chat_id (starts with oc_) per line. Leave blank to push nothing.',
  'settings.feishuMode': 'When to push',
  'settings.feishuModeHint': 'idle waits until the work has fully stopped and sends one message; each-turn sends one message per finished turn. Leave blank for the default (idle).',
  'settings.feishuOutcomes': 'Which results to push',
  'settings.feishuOutcomesHint': 'One per line: completed, failed, stopped. Leave blank for the default (completed and failed).',
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.saveFailed': 'The deployment did not accept these values; they were left for you to correct.',
  'settings.readOnly': 'This deployment stores settings read-only.',
  'settings.unavailable': 'The host does not serve notification settings right now, so they cannot be edited.',
  'settings.overridden': 'Overridden',
  'settings.reset': 'Reset to default',
  'settings.invalid': 'This value is not accepted; change it or clear it to use the default.',
  'settings.invalidNumber': 'Enter a number, or leave blank to use the default.',
  'settings.feed': 'Client read address',
  'settings.feedHint': 'The desktop and mobile clients pull run results from this address. It is read-only and requires local access or a declared entry.',
}

export type Translate = (key: NotifyKey, params?: Record<string, string | number>) => string

/** 取字典：`<html lang>` 以 zh 开头用中文，否则英文。 */
export function makeT(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): Translate {
  const lang = doc?.documentElement?.lang?.toLowerCase() ?? ''
  const table: Record<NotifyKey, string> = lang.startsWith('zh') ? zh : en
  return (key, params) => {
    const text = table[key] ?? key
    if (params === undefined) return text
    return text.replace(/\{(\w+)\}/gu, (match, name: string) => params[name] === undefined ? match : String(params[name]))
  }
}