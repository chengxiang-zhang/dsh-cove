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
import { register } from './index.ts'
import {
  NATIVE_PROVIDER_ROWS, NATIVE_TOOL_ROWS,
  assertNoNativeProvider, describeConflict, findNativeProviderConflict, watchNativeProviders,
} from './mutex.ts'
import type { ExternalSessionGateway } from '../../../core/external-session/gateway.ts'

/**
 * A tools registry that records what a plugin registers.
 *
 * `taken` reproduces the one behaviour of the real registry this domain has to
 * survive: a name that is already owned throws instead of replacing, so whoever
 * registered first keeps the tool.
 */
function fakeTools(options: { taken?: readonly string[] } = {}) {
  const registered = new Map<string, ToolDefinition>()
  const taken = new Set(options.taken ?? [])
  return {
    registered,
    service: {
      register(tool: ToolDefinition): () => void {
        if (taken.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`)
        registered.set(tool.name, tool)
        return () => { registered.delete(tool.name) }
      },
      schemas(): Array<{ name: string }> {
        return [...registered.keys()].map(name => ({ name }))
      },
    },
  }
}

/** Collect every message this context reports through its host logger channel. */
function captureWarnings(ctx: Context): string[] {
  const warnings: string[] = []
  Object.defineProperty(ctx, 'logger', {
    value: () => ({ warn: (message: unknown) => { warnings.push(String(message)) } }),
    configurable: true,
  })
  return warnings
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

  it('names the provider rows that decide the refusal, not only the tool rows', () => {
    // The probe reads the provider registry, so a hint that only lists the tool
    // rows sends the operator to a switch that cannot clear the refusal. Both
    // faces have to appear, plus the bundle that re-ships the provider row.
    const message = describeConflict({ providers: ['claude-code'] })
    for (const row of NATIVE_PROVIDER_ROWS) expect(message).toContain(row)
    for (const row of NATIVE_TOOL_ROWS) expect(message).toContain(row)
    expect(message).toContain('@deepseek-ai/dsh-subagent-claude-code')
    expect(message).toContain('@deepseek-ai/dsh-subagent-codex')
  })

  it('reports a native provider that registers after the mount', () => {
    // The Web profile mounts this entity before the native bundles, so the
    // mount-time probe sees an empty registry. Without the second phase the
    // native provider appears afterwards in silence.
    const ctx = contextWith({ subagents: 'absent' })
    const reported: string[] = []
    const stop = watchNativeProviders(ctx, message => reported.push(message))
    // The subagent service declares `subagent/provider-added`; a bare Context
    // types only the events it owns, so the test drives the name directly.
    const emit = (name: string, payload: unknown): void => {
      (ctx as unknown as { emit: (event: string, value: unknown) => void }).emit(name, payload)
    }

    emit('subagent/provider-added', { name: 'claude-code' })
    // One provider, one report: an operator does not need it per registration.
    emit('subagent/provider-added', { name: 'claude-code' })
    // A local provider is not a conflict and must stay silent.
    emit('subagent/provider-added', { name: 'spawn' })
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain('claude-code')
    expect(reported[0]).toContain('subagent-claude-code')

    stop()
    emit('subagent/provider-added', { name: 'codex' })
    expect(reported).toHaveLength(1)
  })

  it('keeps working on a context that cannot carry events', () => {
    const ctx = contextWith({ subagents: 'absent' })
    Object.defineProperty(ctx, 'on', { value: undefined, configurable: true })
    const stop = watchNativeProviders(ctx, () => { throw new Error('unreachable') })
    expect(() => stop()).not.toThrow()
  })
})

describe('delegation surface on the host domain', () => {
  it('registers both providers and one control pair when the engine mounts', () => {
    const tools = fakeTools()
    const ctx = contextWith({ subagents: 'absent', tools })
    const dispose = register(ctx, { config: { storePath: '/tmp/external-session-mount-test-6.json' } })
    expect([...tools.registered.keys()].sort())
      .toEqual(['external_session_list', 'external_session_stop', 'subagent_claude_code', 'subagent_codex'])
    dispose()
  })

  it('skips a disabled provider and keeps the control tools', () => {
    const tools = fakeTools()
    const ctx = contextWith({ subagents: 'absent', tools })
    const dispose = register(ctx, {
      config: { storePath: '/tmp/external-session-mount-test-7.json', tools: { codex: { enabled: false } } },
    })
    expect([...tools.registered.keys()].sort())
      .toEqual(['external_session_list', 'external_session_stop', 'subagent_claude_code'])
    dispose()
  })

  it('carries the configured catalogue into the tool schema', () => {
    const tools = fakeTools()
    const ctx = contextWith({ subagents: 'absent', tools })
    const dispose = register(ctx, {
      config: {
        storePath: '/tmp/external-session-mount-test-8.json',
        tools: {
          claude: {
            models: [
              { id: 'kaon/claude-opus-5-5', description: 'strongest' },
              { id: 'kaon/claude-haiku-5-5', description: 'cheapest' },
            ],
          },
        },
      },
    })
    const tool = tools.registered.get('subagent_claude_code') as ToolDefinition
    const properties = (tool.parameters as Record<string, unknown>)['properties'] as Record<string, unknown>
    const model = properties['model'] as { oneOf: Array<{ const: string; description: string }> }
    expect(model.oneOf[0]?.const).toBe('kaon/claude-opus-5-5')
    expect(model.oneOf[0]?.description).toBe('strongest')
    dispose()
  })

  it('reports a name it could not take instead of standing down silently', () => {
    // A half-finished migration leaves the native row owning the name. The domain
    // must keep the rest of the surface and say which rows still hold it.
    const tools = fakeTools({ taken: ['subagent_claude_code'] })
    const ctx = contextWith({ subagents: 'absent', tools })
    const warnings = captureWarnings(ctx)
    const dispose = register(ctx, { config: { storePath: '/tmp/external-session-mount-test-9.json' } })
    expect([...tools.registered.keys()].sort())
      .toEqual(['external_session_list', 'external_session_stop', 'subagent_codex'])
    const shadow = warnings.find(message => message.includes('subagent_claude_code'))
    expect(shadow).toBeDefined()
    expect(shadow).toContain('already registered')
    expect(shadow).toContain('subagent-claude-code')
    dispose()
  })
})
