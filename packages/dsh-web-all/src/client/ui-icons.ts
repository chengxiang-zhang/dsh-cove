/**
 * 运行时安全的图标出口。
 *
 * DSH 0.2 的类型声明仍导出 *16/*14 图标，但实际运行时只提供 *Medium/*Regular
 * 变体：直接引用会让 React 拿到 undefined 元素类型并在渲染时抛 #130
 * （右侧栏 Git 页此前正是如此）。本模块按运行时名字优先解析，类型名字兜底，
 * 两者都缺失时退化为不渲染任何图标的空组件。
 */
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentType } from 'react'

/** 图标组件面（size/className 与官方 primitives 一致，其余属性透传）。 */
export type UiIcon = ComponentType<{ size?: number; className?: string } & Record<string, unknown>>

const table = primitives as unknown as Record<string, UiIcon | undefined>
const EMPTY: UiIcon = () => null

function icon(typed: string, runtime: string): UiIcon {
  // 测试里的 module mock、或更早/更晚的 cohort 可能两个名字都没有：访问未知导出
  // 在 vitest 的 mock 代理下会抛错，所以这里整体兜底为空组件。
  try { return table[runtime] ?? table[typed] ?? EMPTY } catch { return EMPTY }
}

export const IconBranchOutline16 = icon('IconBranchOutline16', 'IconBranchOutlineMedium')
export const IconCheckOutline14 = icon('IconCheckOutline14', 'IconCheckOutlineMedium')
export const IconChevronDownOutline14 = icon('IconChevronDownOutline14', 'IconChevronDownOutlineMedium')
export const IconCloseOutline16 = icon('IconCloseOutline16', 'IconCloseOutlineMedium')
export const IconCodeOutline16 = icon('IconCodeOutline16', 'IconCodeOutlineMedium')
export const IconCopyOutline16 = icon('IconCopyOutline16', 'IconCopyOutlineMedium')
export const IconGlobeOutline16 = icon('IconGlobeOutline16', 'IconGlobeOutlineMedium')
export const IconPlusOutline16 = icon('IconPlusOutline16', 'IconPlusOutlineMedium')
export const IconRefreshOutline16 = icon('IconRefreshOutline16', 'IconRefreshOutlineMedium')
export const IconSearchOutline16 = icon('IconSearchOutline16', 'IconSearchOutlineMedium')
export const IconTrashOutline16 = icon('IconTrashOutline16', 'IconTrashOutlineMedium')
