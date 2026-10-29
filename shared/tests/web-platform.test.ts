import { describe, expect, it } from 'vitest'
import { PLATFORM_MODULES } from '../web-platform.ts'

/**
 * Mirrors the shell's frozen module table (dsh-web-frontend dist
 * staticModules, verified against 0.1.5). The rc.8 shell replaced
 * dsh-client-web-react with dsh-client-ui-renderer (a dynamic plugin bundle,
 * not a static module) and stopped sharing dsh-client-schema-form.
 */
const TARGET_SHELL_STATIC_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

describe('platform seed mirrors the shell frozen module table', () => {
  it('contains exactly the target shell static modules', () => {
    expect([...PLATFORM_MODULES].sort()).toEqual([...TARGET_SHELL_STATIC_MODULES].sort())
  })

  it('keeps modules removed from the static table excluded', () => {
    expect(PLATFORM_MODULES).not.toContain('@deepseek-ai/dsh-client-web-react')
    expect(PLATFORM_MODULES).not.toContain('@deepseek-ai/dsh-client-schema-form')
  })
})
