/**
 * Build config for the dsh-web-all entity plugin: node-half lib/ plus the
 * browser bundle lib/client.js (closure-factory artifact for the GUI's
 * __ModuleLoader__). The node half is the one-and-only plugin row `web-all`;
 * all service domains live under src/host/services and are externalized the
 * same way the former per-plugin packages were.
 */
import { clientBundle } from '../../shared/tsdown.client.ts'

export default clientBundle('@dsh-cove/dsh-web-all', ['src/index.ts', 'src/invariant.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-settings-plugins',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-theme',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
  ],
})
