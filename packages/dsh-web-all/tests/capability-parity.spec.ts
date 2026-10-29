import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import manifest from './capability-parity.manifest.json'

const packageRoot = process.cwd()
async function sourceTree(path: string): Promise<string> {
  const root = resolve(packageRoot, path); const files: string[] = []
  async function visit(dir: string): Promise<void> { for (const entry of await readdir(dir, { withFileTypes: true })) { const full = resolve(dir, entry.name); if (entry.isDirectory()) await visit(full); else if (/\.(?:ts|tsx|yml)$/u.test(entry.name)) files.push(await readFile(full, 'utf8')) } }
  await visit(root); return files.join('\n')
}

describe('single-entity static capability parity', () => {
  it('keeps exactly one Cordis runtime row', async () => {
    const patch = await readFile(resolve(packageRoot, 'cordis.patch.yml'), 'utf8')
    expect([...patch.matchAll(/^\s*- id:\s*(\S+)/gmu)].map(match => match[1])).toEqual(manifest.cordisRows)
  })

  it('keeps legacy right-pane kinds rather than blessing simplified replacements', async () => {
    const registry = await readFile(resolve(packageRoot, 'src/client/sidebar/right-pane.tsx'), 'utf8')
    const source = await sourceTree('src/client/sidebar')
    for (const id of manifest.browserSeats['sidebar.right.pane.tab']) expect(registry).toContain(id)
    for (const component of manifest.rightPaneComponents) expect(source.toLowerCase()).toContain(component)
  })

  it('keeps route, namespace, tool, and host service inventory', async () => {
    const source = await sourceTree('src')
    for (const service of manifest.hostServices) expect(source).toContain(service)
    for (const route of manifest.routePrefixes) expect(source).toContain(route)
    for (const tool of manifest.toolNames) expect(source).toContain(tool)
    for (const prefix of manifest.toolPrefixes) expect(source).toContain(prefix)
    for (const namespace of manifest.settingsNamespaces) expect(source).toContain(namespace)
  })

  it('keeps the worktree surface in the conversation position, not the sidebar', async () => {
    // The worktree capability has no sidebar page: its browser half belongs to
    // the conversation position module (composer picker + header lane chip).
    const conversation = (await sourceTree('src/client/conversation')).toLowerCase()
    for (const component of manifest.conversationComponents) expect(conversation).toContain(component)
    const sidebar = await sourceTree('src/client/sidebar')
    expect(sidebar).not.toContain('panels/worktree')
  })

})
