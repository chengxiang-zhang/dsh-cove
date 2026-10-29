/**
 * `web-all-session-lane` dictionaries: the conversation header lane chip.
 * `zh` is the key source; `en` mirrors its key set exactly.
 * @module dsh-client-ui-worktree/client/session-lane-locales
 */

/** Chinese dictionary (key source). */
export const zh = {
  'lane.aria': '当前分支目录：{branch}',
  'lane.local': '未推送',
  'lane.dirty': '有未提交改动',
  'lane.pushed': '已推送',
  'lane.pr': 'PR #{number}',
  'lane.merged': '已合并',
  'lane.presetMissing': '需完全权限才能提交',
  'lane.mainCheckout': '项目主目录',
  'lane.mainCheckoutAria': '当前对话在项目主目录：{branch}',
} as const

/** The session-lane namespace key union. */
export type SessionLaneKey = keyof typeof zh

/** English dictionary (complete mirror of `zh`). */
export const en: Record<SessionLaneKey, string> = {
  'lane.aria': 'Current branch directory: {branch}',
  'lane.local': 'Not pushed',
  'lane.dirty': 'Uncommitted changes',
  'lane.pushed': 'Pushed',
  'lane.pr': 'PR #{number}',
  'lane.merged': 'Merged',
  'lane.presetMissing': 'needs full access to commit',
  'lane.mainCheckout': 'Main directory',
  'lane.mainCheckoutAria': "This conversation is in the project's main directory: {branch}",
}
