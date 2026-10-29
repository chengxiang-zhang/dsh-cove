import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = async (path: string): Promise<string> => await readFile(resolve(process.cwd(), path), 'utf8')

/**
 * Semantic hooks of the surfaces the entity ships.
 *
 * Every family page is a native 0.2 main panel now, so the page-level hooks
 * live on the page shell (`data-dsh-page`) and each page keeps its own
 * `plugin` marker plus the row/entry hooks.
 */
describe('shipped semantic attributes', () => {
  it('keeps the SSH page hooks (native panel body)', async () => {
    const panel = await source('src/client/sidebar/panels/ssh/SshPanel.tsx')
    expect(panel).toContain('plugin="ssh"')
    expect(panel).toContain('data-dsh-part="tab-bar"')
    const hosts = await source('src/client/sidebar/panels/ssh/HostsTab.tsx')
    for (const hook of ['data-dsh-part="host-table"', 'data-dsh-part="host-row"']) expect(hosts).toContain(hook)
    const terminal = await source('src/client/sidebar/panels/ssh/TerminalTab.tsx')
    expect(terminal).toContain('data-dsh-part="terminal"')
  })

  it('keeps the memoir page hooks (native panel body)', async () => {
    const memoir = await source('src/client/sidebar/panels/memoir/panel.tsx')
    for (const hook of ['plugin="memoir"', 'data-dsh-part="tabs"', 'data-dsh-part="toolbar"', 'data-dsh-part="entry"', 'data-dsh-part="entry-form"', 'data-dsh-part="scroll-region"']) expect(memoir).toContain(hook)
  })

  it('keeps the worktree surface hooks (header chip + lane menu)', async () => {
    const chip = await source('src/client/conversation/session-lane-chip.tsx')
    for (const hook of ['WORKTREE_PLUGIN', 'WORKTREE_PART_LANE_CHIP']) expect(chip).toContain(hook)
    const menu = await source('src/client/conversation/worktree/lane-menu.tsx')
    for (const hook of ['WORKTREE_PLUGIN', 'WORKTREE_PART_LANE_MENU']) expect(menu).toContain(hook)
    const shell = await source('src/client/sidebar/page-shell.tsx')
    expect(shell).toContain('data-dsh-page=""')
  })

  it('marks the native panellist rows and the Feishu settings page', async () => {
    const rows = await source('src/client/sidebar/native-panels.tsx')
    for (const id of ["SSH_PANEL_ID = 'web-all-ssh'", "MEMOIR_PANEL_ID = 'web-all-memoir'"]) expect(rows).toContain(id)
    expect(rows).toContain("name: 'sidebar.panellist'")
    const settings = await source('src/client/settings/lark-inbox.tsx')
    expect(settings).toContain('data-dsh-plugin="lark-inbox"')
    expect(settings).toContain('data-dsh-part="settings"')
    const wizard = await source('src/client/lark-inbox/wizard.tsx')
    expect(wizard).toContain('data-dsh-part="wizard"')
  })

  it('keeps the git-graph chip and the right-pane workbench hooks', async () => {
    const chip = await source('src/client/conversation/git-graph/branch-chip.tsx')
    expect(chip).toContain('data-dsh-plugin="git-graph"')
    expect(chip).toContain('data-dsh-part="chip"')
    const pane = await source('src/client/sidebar/right-pane.tsx')
    expect(pane).toContain('data-dsh-part="native-fused"')
    const workbench = await source('src/client/sidebar/git-workbench.tsx')
    expect(workbench).toContain('data-dsh-part="workbench-git"')
  })
})