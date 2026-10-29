/**
 * memoir host 服务域（全新实现；行为契约参考旧包）。
 *
 * 记忆系统：store（按项目路径分键的条目存储）+ settings + 
 * /api/dsh-memoir/* 路由族 + agent 工具（memoir_record/read/update）。
 * 注册入口 register(ctx, deps)，由 host 装配器统一调用。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { MemoirStore, renderHotMemory } from './store.ts'
import { MemoirSettingsStore } from './settings.ts'
import { registerRoutes } from './routes.ts'
import { makeMemoirTools } from './tools.ts'
import { registerResources } from '../resources.ts'

export { MemoirStore, type MemoirEntry, type SectionKey } from './store.ts'
export { MemoirSettingsStore, type MemoirSettings } from './settings.ts'

const SECTION_ORDER = 150
export const MEMOIR_GUIDANCE = 'dsh-memoir 提供项目持久记忆。下方仅注入本项目高优先级记忆；需要历史细节时调用 memoir_read；产生可复用的工作结论、经验或后续行动时调用 memoir_record。'
export const MEMOIR_SECTION_HEADING = '## 项目持久记忆（自动注入）'
export const PROMPT_MEMORY_VARIABLE = 'project_memory'
export const PROMPT_MEMORY_REFERENCE = '{{project_memory}}'

interface MemoirAssembleContext {
  agent?: { session?: { header?: { cwd?: string } } }
}

/** Build the variable value; raw memory never enters section text. */
export function memoirVariableText(store: MemoirStore, context: MemoirAssembleContext, maxTokens: number): string {
  const cwd = context.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd === '') return MEMOIR_GUIDANCE
  const hot = renderHotMemory(store.project(cwd), maxTokens)
  return hot === '' ? MEMOIR_GUIDANCE : `${MEMOIR_GUIDANCE}\n\n${MEMOIR_SECTION_HEADING}\n${hot}`
}

/** 服务域依赖。 */
export interface MemoirServiceDeps {
  /** 存储路径（默认 ~/.dsh/dsh-memoir.json）。 */
  storePath?: string
  /** 设置路径（默认 ~/.dsh/dsh-memoir.settings.json）。 */
  settingsPath?: string
  /** 日志。 */
  logger?: { warn(error: unknown): void }
}

/** 服务域注册入口；返回统一 disposer。 */
export function register(ctx: Context, deps: MemoirServiceDeps = {}): () => void {
  const logger = deps.logger ?? { warn: (error: unknown) => { console.warn('[web-all:memoir]', error) } }
  const store = new MemoirStore(deps.storePath)
  const settingsStore = new MemoirSettingsStore(deps.settingsPath)
  const settings = (): ReturnType<MemoirSettingsStore['load']> => settingsStore.load()
  const saveSettings = (value: ReturnType<MemoirSettingsStore['load']>): void => { settingsStore.save(value) }

  return registerResources(own => {
    own(registerRoutes(ctx, { store, settings, saveSettings, logger }))
    for (const tool of makeMemoirTools(store, settings)) own(ctx.tools.register(tool))

    let disposePrompt: (() => void) | undefined
    const syncPrompt = (): void => {
      disposePrompt?.()
      disposePrompt = undefined
      const current = settings()
      if (!current.enabled || !current.announceToAgent) return
      disposePrompt = registerResources(ownPrompt => {
        ownPrompt(ctx.systemPrompt.variable(PROMPT_MEMORY_VARIABLE, context =>
          memoirVariableText(store, context as MemoirAssembleContext, settings().hotMemoryMaxTokens)))
        ownPrompt(ctx.systemPrompt.section({
          name: 'plugin:dsh-memoir',
          order: SECTION_ORDER,
          text: PROMPT_MEMORY_REFERENCE,
        }))
      })
    }
    own(() => { disposePrompt?.() })
    own(settingsStore.subscribe(() => syncPrompt()))
    syncPrompt()
  })
}
