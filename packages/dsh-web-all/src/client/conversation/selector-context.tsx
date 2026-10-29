/**
 * 输入区 dock 的 git 分支 chip（DSH 0.2）。
 *
 * 0.2 不再有 `conversation.input.selector.context` 槽（0.1 时代的首选席位），
 * 官方 `conversation.input.dock` 是 session 作用域、由 `inject(sessionId)` 注入
 * 会话身份；因此这里直接注册到 dock 并携带 sessionId（旧的 2 秒回退等待已移除，
 * 分支 chip 不再延迟出现、也不再依赖已删除的 `sessions.list.current`）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createGitBranchFace } from './git-branch.tsx'

/** 装配输入区分支 chip（dock 席位）。 */
export function mountSelectorContext(ctx: ClientContext): () => void {
  const face = createGitBranchFace(ctx)
  return ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'web-all-git-branch-chip',
    order: 100,
    inject: (sessionId: string) => ({ sessionId }),
  }, face))
}