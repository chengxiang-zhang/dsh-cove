/**
 * 本能力的语义标记：面板根容器与下拉分组共用同一个能力短名。
 *
 * 部件名（`data-dsh-part`）各自在本文件或所属模块里声明，归属交给 plugin 属性
 * （仓库语义属性约定：`data-dsh-plugin="<能力短名>"` + 裸值 `data-dsh-part`）。
 */

/** 能力短名。 */
export const EXTERNAL_SESSION_PLUGIN = 'external-session'

/** 面板根容器。 */
export const PANEL_PART = 'root'

/** 下拉里的分组容器与叶节点。 */
export const GROUP_PART = 'group'
export const ROW_PART = 'row'
