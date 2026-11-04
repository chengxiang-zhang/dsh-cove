/**
 * Mount-level evidence: the conflict refusal and the degraded tool surface.
 *
 * These run against a real Cordis `Context` rather than a hand-rolled object,
 * because what is being proved is how the domain behaves when the loader mounts
 * it: the `subagents` service is resolved through the context, absence must not
 * take the entity down, and a preset row whose engine is missing must still
 * produce callable tools.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply as applyPresetTools } from '../../../preset-tools.ts'
import { register } from './index.ts'
import { assertNoNativeProvider, describeConflict, findNativeProviderConflict } from './mutex.ts'
import type { ExternalSessionGateway } from '../../../core/external-session/gateway.ts'

/** A tools registry that records what a plugin registers. */
function fakeTools() {
  const registered = new Map<string, ToolDefinition>()
  return {
    registered,
    service: {
      register(tool: ToolDefinition): () => void {
        registered.set(tool.name, tool)
        return () => { registered.delete(tool.name) }
      },
      schemas(): Array<{ name: string }> {
        return [...registered.keys()].map(name => ({ name }))
      },
    },
  }
}

/** A web server that accepts route registrations and forgets them. */
const fakeWebServer = {
  register(): () => void {
    return () => {}
  },
}

/** A context with the services this domain reaches for. */
function contextWith(options: { subagents?: unknown | 'absent'; tools?: ReturnType<typeof fakeTools> } = {}): Context {
  const ctx = new Context()
  ctx.provide('webServer', fakeWebServer)
  if (options.subagents !== 'absent' && options.subagents !== undefined) {
    ctx.provide('subagents', options.subagents)
  }
  if (options.tools !== undefined) ctx.provide('tools', options.tools.service)
  return ctx
}

describe('external-session mutex against the native providers', () => {
  it('passes when the subagent service is absent', () => {
    const ctx = contextWith({ subagents: 'absent' })
    expect(findNativeProviderConflict(ctx)).toEqual({ providers: [] })
    expect(() => assertNoNativeProvider(ctx)).not.toThrow()
  })

  it('identifies the native providers it knows', () => {
    expect(findNativeProviderConflict(contextWith({ subagents: { list: () => ['claude-code', 'codex'] } })))
      .toEqual({ providers: ['claude-code', 'codex'] })
    // Only the external ones matter: local providers are not a conflict.
    expect(findNativeProviderConflict(contextWith({ subagents: { list: () => ['spawn', 'fork', 'codex'] } })))
      .toEqual({ providers: ['codex'] })
    // Objects that name themselves are recognized too.
    expect(findNativeProviderConflict(contextWith({ subagents: { list: () => [{ provider: 'claude-code' }] } })))
      .toEqual({ providers: ['claude-code'] })
  })

  it('refuses to mount while a native external provider is registered, naming the switches', () => {
    const ctx = contextWith({ subagents: { list: () => ['claude-code'] } })
    expect(() => register(ctx)).toThrow(/native external subagent provider/)
    try {
      register(ctx)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The close guidance is the actionable half: a refusal without it is a dead end.
      expect(message).toContain('claude-code')
      expect(message).toContain('tool-subagent-claude-code')
      expect(message).toContain('tool-subagent-codex')
      expect(message).toContain('external-session')
    }
  })

  it('mounts and provides the engine when no native provider is registered', () => {
    const ctx = contextWith({ subagents: 'absent' })
    const dispose = register(ctx, { config: { storePath: '/tmp/external-session-mount-test.json' } })
    const gateway = (ctx as unknown as { get?: (id: string) => unknown }).get?.('externalSession') as ExternalSessionGateway | undefined
    expect(gateway).toBeDefined()
    expect(typeof gateway?.runTurn).toBe('function')
    dispose()
  })

  it('survives a registry that cannot answer instead of failing the mount', () => {
    const warnings: string[] = []
    const ctx = contextWith({ subagents: { list() { throw new Error('registry exploded') } } })
    expect(findNativeProviderConflict(ctx)).toEqual({ providers: [] })
    expect(() => assertNoNativeProvider(ctx, message => warnings.push(message))).not.toThrow()
    const explodingCtx = contextWith({ subagents: { get list(): never { throw new Error('boom') } } })
    expect(() => register(explodingCtx)).not.toThrow()
  })

  it('describes a conflict with the operator action', () => {
    expect(describeConflict({ providers: ['codex'] })).toContain('Turn off the native external subagent providers')
  })
})

describe('preset-tools visibility', () => {
  it('stands down with no tool and one warning when the engine is absent', () => {
    const tools = fakeTools()
    const ctx = contextWith({ subagents: 'absent', tools })
    // Capture the host logger channel the stand-down reports through.
    const warnings: unknown[] = []
    Object.defineProperty(ctx, 'logger', {
      value: () => ({ warn: (message: unknown) => { warnings.push(message) } }),
      configurable: true,
    })
    expect(() => applyPresetTools(ctx, { provider: 'claude', toolName: 'subagent_claude_code' })).not.toThrow()
    // D14: an inert row is the point — the live host may still own that name.
    expect([...tools.registered.keys()]).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0])).toContain('not registered')
  })

  it('registers exactly one delegation tool per row and skips control tools when told to', () => {
    const tools = fakeTools()
    const ctx = contextWith({ subagents: 'absent', tools })
    const dispose = register(ctx, { config: { storePath: '/tmp/external-session-mount-test-3.json' } })
    applyPresetTools(ctx, { provider: 'codex', toolName: 'subagent_codex', control: false })
    expect([...tools.registered.keys()]).toEqual(['subagent_codex'])
    dispose()
  })

  it('registers all three tools once the host service is mounted', async () => {
    const tools = fakeTools()
    const ctx = contextWith({ subagents: 'absent', tools })
    const dispose = register(ctx, { config: { storePath: '/tmp/external-session-mount-test-4.json' } })
    applyPresetTools(ctx, { provider: 'claude', toolName: 'subagent_claude_code' })
    expect([...tools.registered.keys()].sort())
      .toEqual(['external_session_list', 'external_session_stop', 'subagent_claude_code'])

    const list = tools.registered.get('external_session_list') as ToolDefinition
    // An empty store answers with an empty list: the tools now reach the engine.
    expect(await list.execute({}, {} as never)).toEqual({ sessions: [] })
    dispose()
  })
})
