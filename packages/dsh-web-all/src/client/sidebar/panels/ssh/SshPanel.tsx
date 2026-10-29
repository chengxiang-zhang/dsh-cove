/**
 * SSH 主栏页面：0.2 原生 `main` 面板，版心与加载态复用 page-shell（与官方
 * 插件页同形）。页头下是五个标签页（主机 / 终端 / 传输 / 隧道 / 集群），
 * 标签状态属于浏览器会话状态；未激活的标签卸载，因此每个标签在激活时各自
 * 取数。主机页的连接动作会切到终端标签并预选别名。
 */
import { useState } from 'react'
import type { SshApi } from './api.ts'
import { tt, type TerminalFontSource } from './helpers.ts'
import { ClusterTab } from './ClusterTab.tsx'
import { HostsTab } from './HostsTab.tsx'
import { TerminalTab } from './TerminalTab.tsx'
import { TransferTab } from './TransferTab.tsx'
import { TunnelsTab } from './TunnelsTab.tsx'
import { PageSection, PageShell } from '../../page-shell.tsx'
import css from './panel.module.css'

/** The panel's tab identifiers. */
export type SshTab = 'hosts' | 'terminal' | 'transfer' | 'tunnels' | 'cluster'

/** Panel shell props. */
export interface SshPanelProps {
  /** The SSH API client every tab operates through. */
  api: SshApi
  /** Live terminal-font setting source handed to the terminal tab (issue #577). */
  terminalFont?: TerminalFontSource
}

/** The tab bar definition (labels resolved at render time). */
const TABS: ReadonlyArray<{ id: SshTab; label: () => string }> = [
  { id: 'hosts', label: () => tt('tab.hosts') },
  { id: 'terminal', label: () => tt('tab.terminal') },
  { id: 'transfer', label: () => tt('tab.transfer') },
  { id: 'tunnels', label: () => tt('tab.tunnels') },
  { id: 'cluster', label: () => tt('tab.cluster') },
]

/** A pending "connect this host" request handed to the terminal tab. */
interface ConnectRequest {
  alias: string
  nonce: number
}

/** The tabbed SSH page. */
export function SshPanel({ api, terminalFont }: SshPanelProps) {
  const [activeTab, setActiveTab] = useState<SshTab>('hosts')
  const [connectRequest, setConnectRequest] = useState<ConnectRequest | null>(null)

  const handleConnect = (alias: string): void => {
    setActiveTab('terminal')
    setConnectRequest(prev => ({ alias, nonce: (prev?.nonce ?? 0) + 1 }))
  }

  return (
    <PageShell plugin="ssh" title={tt('panel.title')} intro={tt('panel.intro')}>
      <PageSection>
        <div className={css.tabBar} role="tablist" data-dsh-part="tab-bar">
          {TABS.map(tab => (
            <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} data-active={activeTab === tab.id ? '' : undefined} data-dsh-part="tab" className={css.tab} onClick={() => { setActiveTab(tab.id) }}>
              {tab.label()}
            </button>
          ))}
        </div>
      </PageSection>
      <PageSection fill>
        <div className={css.panelContent} data-dsh-part="panel-content">
          {activeTab === 'hosts' && <HostsTab api={api} onConnect={handleConnect} />}
          {activeTab === 'terminal' && <TerminalTab api={api} presetAlias={connectRequest?.alias} requestId={connectRequest?.nonce} terminalFont={terminalFont} />}
          {activeTab === 'transfer' && <TransferTab api={api} />}
          {activeTab === 'tunnels' && <TunnelsTab api={api} />}
          {activeTab === 'cluster' && <ClusterTab api={api} />}
        </div>
      </PageSection>
    </PageShell>
  )
}