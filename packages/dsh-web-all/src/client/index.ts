/**
 * dsh-web-all — browser half.
 *
 * 全家桶实体插件的 client 半区：按 dsh 注入位置组织，位置是第一维度。
 * 三个位置模块（sidebar / settings / conversation）各自负责一个
 * 注入位置的全部注册与编排；本文件只做装配：挂 compat 补标、加载位置模块。
 *
 * 不再存在任何独立插件行：cordis.patch.yml 只有一行 `web-all`。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { mountCompat } from './compat.ts'
import { mountGatewayTrust } from './trust.ts'
import { mountSidebar } from './sidebar/index.ts'
import { mountConversation } from './conversation/index.ts'
import { mountLarkSettings } from './settings/lark-inbox.tsx'
import { mountNotifySettings } from './settings/notify.tsx'

/** Required services shared by the position modules (each may declare more). */
export const inject = [
  'slots',
  'locale',
  'sessions',
  'theme',
  'connection',
  'remote',
  'workspaces',
] as const

/**
 * Application entry：装配四个位置模块 + compat shim。
 * 每个位置模块直接挂载其完整能力并共享同一 Cordis 生命周期。
 * @param ctx - client root context。
 */
/** 单模块挂载隔离：任一位置模块抛错不再拖垮整块客户端（并留下可诊断日志）。 */
function mountPosition(ctx: ClientContext, label: string, fn: () => () => void): void {
  ctx.effect(() => {
    try {
      return fn()
    } catch (error) {
      console.error(`[web-all] ${label} mount threw:`, error)
      return () => {}
    }
  }, `web-all: ${label}`)
}

export function apply(ctx: ClientContext): void {
  // 最先挂：网关页面的宿主信任（否则 0.2 会把设置面降级成内存态，模型页读不到配置）。
  mountPosition(ctx, 'gateway trust', () => mountGatewayTrust(ctx))
  // 家族只在设置页保留飞书配置（内置插件标签页），其余能力全部走默认值。
  mountPosition(ctx, 'compat', () => mountCompat())
  mountPosition(ctx, 'sidebar position', () => mountSidebar(ctx))
  mountPosition(ctx, 'conversation position', () => mountConversation(ctx))
  mountPosition(ctx, 'settings position', () => mountLarkSettings(ctx))
  // 通知是飞书接入的出站半边，与「飞书」页并列成第二个标签页：两者配置同一个
  // 机器人，但一个是「怎么收」、一个是「怎么发」，混在一页里两边的说明都会变糊。
  mountPosition(ctx, 'settings position (notify)', () => mountNotifySettings(ctx))
}