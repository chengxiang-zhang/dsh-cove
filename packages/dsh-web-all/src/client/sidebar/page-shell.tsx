/**
 * 原生页面外壳 —— 与官方插件页（PluginManagerPage）同一套版心与加载外观。
 *
 * 官方插件页的结构是：`section[data-plugin-panel]`（100% 高、外层滚动、
 * clamp(24px,4vw,48px) 左右留白）＋ 居中 960px 内容列 ＋ 28px 上边距的页头
 * （20px/500 标题 + 13px 说明行）＋ 右侧工具条；数据未就绪时用 `aria-busy`
 * 与提示行表达。SSH / 记忆 / Git Worktree 三个家族主栏面板统一复用本模块，
 * 因此它们的加载方式与布局和官方插件页完全一致。
 */
import type { ReactNode } from 'react'
import css from './page-shell.module.css'

/** 页面外壳属性。 */
export interface PageShellProps {
  /** 页面标题，与侧栏行使用同一个名字。 */
  title: string
  /** 家族标记：写到 `data-dsh-plugin`（沿用各面板原来的语义属性）。 */
  plugin?: string
  /** 标题下的说明行；省略或空串时不渲染。 */
  intro?: string
  /** 页头右侧工具条内容。 */
  toolbar?: ReactNode
  /** 数据加载中：驱动 `aria-busy` 并让读屏软件播报加载态。 */
  busy?: boolean
  /** 页面内容：每个直接子节点都是 960px 版心内的一节。 */
  children: ReactNode
}

/** 版心内的一节内容（分组）。 */
export interface PageSectionProps {
  /** 填满页头以下的剩余高度（终端、列表这类需要内部滚动的区块）。 */
  fill?: boolean
  /** 追加的类名（内容自有样式）。 */
  className?: string
  children: ReactNode
}

/** 加载 / 空 / 失败提示行的种类。 */
export type PageNoticeKind = 'loading' | 'empty' | 'error'

/** 提示行属性。 */
export interface PageNoticeProps {
  kind: PageNoticeKind
  /** 提示文案。 */
  children: ReactNode
  /** 右侧动作（例如「重试」）；省略则不渲染。 */
  action?: ReactNode
}

/** 提示行在版本内的稳定标记。 */
export const PAGE_NOTICE_PART = 'page-notice'

/** 一节内容：与插件页的分组同款纵向布局。 */
export function PageSection({ fill = false, className, children }: PageSectionProps): JSX.Element {
  const classes = [css.section, fill ? css.sectionFill : '', className ?? ''].filter((name) => name !== '')
  return <div className={classes.join(' ')}>{children}</div>
}

/** 加载 / 空 / 失败提示行：与插件页的 status 行同款排版。 */
export function PageNotice({ kind, children, action }: PageNoticeProps): JSX.Element {
  const classes = kind === 'error' ? `${css.notice} ${css.noticeError}` : css.notice
  return (
    <p className={classes} data-dsh-part={PAGE_NOTICE_PART} data-kind={kind}>
      <span>{children}</span>
      {action === undefined ? null : <span className={css.noticeAction}>{action}</span>}
    </p>
  )
}

/** 主栏页面外壳。 */
export function PageShell({ title, plugin, intro, toolbar, busy = false, children }: PageShellProps): JSX.Element {
  return (
    <section className={css.page} data-dsh-page="" aria-busy={busy} {...(plugin === undefined ? {} : { 'data-dsh-plugin': plugin })}>
      <header className={css.pageHead} data-window-drag="">
        <div className={css.pageHeading}>
          <h1 className={css.pageTitle}>{title}</h1>
          {intro === undefined || intro === '' ? null : (
            <div className={css.pageIntro} data-dsh-part="page-intro"><span>{intro}</span></div>
          )}
        </div>
        {toolbar === undefined ? null : <div className={css.toolbar} data-dsh-part="page-toolbar">{toolbar}</div>}
      </header>
      {children}
    </section>
  )
}