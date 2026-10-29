/**
 * `worktree` namespace dictionaries: the conversation header chip's popover
 * (facts, the PR action, and one delete action) and the dialogs it opens.
 * zh is the key-set source of truth; en must keep the exact same key set.
 *
 * Copy rule (issue: the names were unreadable): these strings are what the user
 * reads, so they say "分支目录 / branch directory" and never the implementation
 * words `worktree` or `lane`. `tests/worktree-client-locales.spec.ts` enforces
 * that on both dictionaries.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'menu.aria': '管理该分支的目录（{branch}）',
  'menu.path': '目录',
  'menu.pr': '提交 PR',
  'menu.delete': '删除…',
  'menu.refresh': '检查是否已合并',
  'menu.running': '当前对话正在运行：请先停止本轮，再删除。',
  'menu.selfTeardown': '该目录属于当前对话：删除会一并归档本对话。',
  'worktree.prTitle': '为「{name}」提交 PR',
  'worktree.prDescription': '推送该分支并创建 pull request。默认打开 GitHub 对比页；配置了 GitHub token 时直接调用 API 创建。',
  'worktree.prBase': '目标分支（base）',
  'worktree.prConfirm': '推送并创建 PR',
  'worktree.prOpen': '打开 PR',
  'worktree.prSuccess': '分支已推送，PR 已就绪：',
  'worktree.deleteTitle': '删除「{name}」',
  'worktree.deleteDescription': '删除该分支的目录与记录，并归档它的对话。',
  'worktree.deleteBranch': '同时删除本地分支',
  'worktree.deleteBranchHint': '不勾选时只删目录，本地分支保留，之后还能再用它建目录。',
  'worktree.deleteForce': '强制删除（丢弃未提交改动；未合并的分支也删）',
  'worktree.deleteForceWarning': '强制会丢弃未提交改动；未合并的分支也会被删除，不可恢复。',
  'worktree.deleteConfirm': '删除',
  'dialog.close': '关闭',
  'dialog.cancel': '取消',
  'dialog.confirm': '确定',
  'error.gitFailed': 'git 操作失败：{error}',
  'error.worktreeExists': '同名分支已存在，请换个名字，或先删掉旧分支。',
  'error.worktreeNotFound': '没有找到这个目录。',
  'error.notARepository': '这个目录不是 git 仓库。',
  'error.workspaceUnknown': '这个目录不在你的 DSH 工作区里，无法在这里操作。',
  'error.invalidBranch': '分支名不可用。',
  'error.worktreeBusy': '这个目录还有正在运行的对话，或存在未提交改动；请先停止对话，或勾选强制删除。',
  'error.notMerged': '这个分支还没合并；请先合并 PR，或勾选强制删除。',
  'error.laneSession': '没能把对话绑定到这个目录：主机没有这条绑定记录（目录可能不在清单里，或会话服务不可用）。',
  'error.laneMismatch': '这个对话不在该分支目录里，无法绑定。',
  'error.permissionDenied': '操作被拒绝：只有本机，或带浏览器会话的受信入口才允许修改分支目录。',
  'error.unreachable': '连不上分支目录服务：{error}',
} satisfies Record<string, string>

/** The worktree namespace key union. */
export type WorktreeKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    worktree: WorktreeKey
  }
}

/** English dictionary, checked complete against the zh key set. */
export const en: Record<WorktreeKey, string> = {
  'menu.aria': 'Manage the directory for this branch ({branch})',
  'menu.path': 'Directory',
  'menu.pr': 'Open PR',
  'menu.delete': 'Delete…',
  'menu.refresh': 'Check whether it is merged',
  'menu.running': 'This conversation is running: stop the current turn before deleting.',
  'menu.selfTeardown': 'This directory belongs to this conversation: deleting archives the conversation too.',
  'worktree.prTitle': 'Open a pull request for "{name}"',
  'worktree.prDescription': 'Pushes the branch and creates a pull request. Opens the GitHub compare page by default; uses the REST API when a GitHub token is configured.',
  'worktree.prBase': 'Target branch (base)',
  'worktree.prConfirm': 'Push and create PR',
  'worktree.prOpen': 'Open PR',
  'worktree.prSuccess': 'Branch pushed, PR ready:',
  'worktree.deleteTitle': 'Delete "{name}"',
  'worktree.deleteDescription': "Deletes this branch's directory and its record, and archives its conversation.",
  'worktree.deleteBranch': 'Also delete the local branch',
  'worktree.deleteBranchHint': 'Leave it unchecked to keep the local branch, so a directory can be made for it again later.',
  'worktree.deleteForce': 'Force delete (discard uncommitted changes; delete an unmerged branch too)',
  'worktree.deleteForceWarning': 'Force discards uncommitted changes and deletes an unmerged branch. This cannot be undone.',
  'worktree.deleteConfirm': 'Delete',
  'dialog.close': 'Close',
  'dialog.cancel': 'Cancel',
  'dialog.confirm': 'Confirm',
  'error.gitFailed': 'git failed: {error}',
  'error.worktreeExists': 'A local branch with that name already exists; choose another name or delete the old branch first.',
  'error.worktreeNotFound': 'No such directory.',
  'error.notARepository': 'This directory is not a git repository.',
  'error.workspaceUnknown': 'This directory is not one of your DSH workspaces, so it cannot be used here.',
  'error.invalidBranch': 'That branch name is not valid.',
  'error.worktreeBusy': 'A running conversation or uncommitted changes block this directory; stop the conversation, or use force delete.',
  'error.notMerged': 'The branch is not merged yet; merge the pull request first, or use force delete.',
  'error.laneSession': 'Could not bind the conversation to this directory: the host recorded no binding (the directory may be missing from its manifest, or the sessions service is unavailable).',
  'error.laneMismatch': 'This conversation is not running in that branch directory, so it cannot be bound to it.',
  'error.permissionDenied': 'Permission denied: only this machine, or a deployment-declared browser entry with a session, may change a branch directory.',
  'error.unreachable': 'The branch directory service did not answer: {error}',
}