/**
 * 位置模块：会话区（conversation）— 唯一负责 conversation.* 注入的位置模块。
 *
 * 收编：git-graph 分支 chip（官方 `conversation.input.dock`，会话作用域注入
 * sessionId；它是唯一的 worktree 创建入口——选分支即为该分支建 worktree）、
 * subagent 模型徽标、会话标题后的 lane chip（官方
 * `conversation.session.header.actions`：显示本会话所在分支与状态，并承载该
 * worktree 的收尾动作——提 PR / 清理 / 移除）。
 *
 * worktree 的界面只有这两处：输入框上方的分支选择器（创建）与会话顶部的 lane
 * chip（查看与收尾）。侧栏不再有 Worktrees 页面，`worktree` 命名空间（chip
 * 弹层与各对话框的文案）因此由本模块注册。
 *
 * 自动化任务「投递到原对话还是每次新对话」**没有界面入口**：它在创建任务时由
 * 自然语言 + agent 工具（`schedule_mode_set` / `schedule_mode_list`）一次设定，
 * 所以本位置模块不再注入任何 schedule 相关的槽位。
 *
 * 不再有独立的「新建 worktree / 工作线」选择器：分支与 worktree 是同一个动作。
 * 每条 lane 的目录会注册成一个 DSH 工作区——这是平台约束而非口味：注册表只把 cwd
 * 等于工作区路径的会话算作该工作区的成员，而没有任何工作区认领的空白对话，输入框
 * 是禁用的（只显示「选择一个工作区开始」）。因此选分支时本模块调用平台自己的工作区
 * 导航 `uiWorkspace.openWorkspace`，把当前对话真正切到新 lane 上，再把配对关系绑到
 * 该会话；拆除 lane 时工作区注册随目录一起注销，侧栏只留还活着的 lane。切换动作不
 * 来自席位 props——dock 席位只收 `{ session, input }`，从那里读切换函数只会静默不切。
 *
 * 回合产出文件 chips（turnTail）已移除：它是 0.1 时代的 select 链注册（0.2 的
 * 该槽只传 `{turn, seq, openFile}`，收不到 `matched`，每回合必崩），而 0.2 原生
 * `@deepseek-ai/dsh-client-ui-deliverables` 已经提供同位的「本回合改动/产物」chip。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { mountSelectorContext } from './selector-context.tsx'
import { gitGraphEn, gitGraphZh } from './git-branch.tsx'
import { mountSessionLaneChip, sessionLaneEn, sessionLaneZh } from './session-lane-chip.tsx'
import { mountSubagentModel } from './subagent-model.ts'
import { en as worktreeEn, zh as worktreeZh } from './worktree/locales.ts'
import { mountLaneWorkspaceSweeper, type LaneSweeperWorkspaces } from './worktree/lane-workspace-sweeper.ts'

/** 会话区位置模块 locale 命名空间。 */
export const NS = 'web-all-conversation'

/** Conversation copy keys; zh in subagent-model.ts is the key source. */
export type ConversationLocaleKey = 'subagentModel.badge.aria'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Conversation position module copy. */
    'web-all-conversation': ConversationLocaleKey
  }
}

/** 装配会话区位置模块。 */
export function mountConversation(ctx: ClientContext): () => void {
  const disposers = [
    ctx.locale.register('web-all-git-graph', { zh: gitGraphZh, en: gitGraphEn }),
    ctx.locale.register('web-all-session-lane', { zh: sessionLaneZh, en: sessionLaneEn }),
    // The lane chip's popover and the dialogs it opens speak the worktree
    // namespace; the conversation position module owns that surface now.
    ctx.locale.register('worktree', { zh: worktreeZh, en: worktreeEn }),
    mountSelectorContext(ctx),
    mountSessionLaneChip(ctx),
    mountSubagentModel(ctx),
    // lane 的工作区注册不能比它自己的对话活得久：对话全部归档后就注销那一行
    // （目录、分支、绑定都留着，再选该分支即可一步重建）。这里挂在会话区模块，
    // 因为 lane 的浏览器半区就在本模块；它不占任何槽位，只是订阅工作区列表。
    mountLaneWorkspaceSweeper({
      workspaces: optionalWorkspaceService(ctx),
      warn: (message, error) => { console.warn(message, error) },
    }),
  ]
  return () => { for (const dispose of disposers) dispose() }
}

/** 取可选的工作区服务（缺失或抛错都返回 undefined）。 */
function optionalWorkspaceService(ctx: ClientContext): LaneSweeperWorkspaces | undefined {
  try {
    return (ctx.get as unknown as (id: string, strict?: boolean) => unknown)('workspaces', false) as LaneSweeperWorkspaces | undefined
  } catch {
    return undefined
  }
}