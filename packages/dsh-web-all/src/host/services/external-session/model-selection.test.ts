/**
 * Call-time model selection: argv, schema and the request the engine receives.
 *
 * The three have to agree. A model that only reaches the parameter schema would
 * look selectable and change nothing; a model that only reaches argv would be
 * invisible to the model choosing it. These tests pin the whole path per provider,
 * because the two CLIs express the same choice with different arguments.
 */
import { describe, expect, it, vi } from 'vitest'
import { claudeTurnArgv, spawnArgv as claudeSpawnArgv } from './providers/claude.ts'
import { codexTurnArgv, spawnArgv as codexSpawnArgv } from './providers/codex.ts'
import { makeDelegationTool } from './tools.ts'
import type { ExternalSessionGateway } from '../../../core/external-session/gateway.ts'
import type { ExternalModelOption } from '../../../core/external-session/types.ts'

const CATALOGUE: ExternalModelOption[] = [
  { id: 'kaon/claude-sonnet-5-5', description: 'balanced default' },
  { id: 'kaon/claude-opus-5-5', description: 'strongest, most expensive' },
]

/** The minimum an execution context must provide for this tool. */
function execContext(): { signal: AbortSignal } {
  return { signal: new AbortController().signal }
}

/** A gateway that records the request instead of spawning a CLI. */
function recordingGateway() {
  const requests: Array<Record<string, unknown>> = []
  const gateway = {
    async startTurn(request: Record<string, unknown>) {
      requests.push(request)
      return {
        session_id: 'ext-1',
        turn: 1,
        status: 'running',
        progress: { elapsed_ms: 0, idle_ms: 0, frames: 0, tool_calls: 0, chars: 0, tail: '' },
      }
    },
    async awaitTurn() {
      return { session_id: 'ext-1', turn: 1, status: 'completed', result: 'ok', usage: null, cost_usd: null, can_continue: false }
    },
  }
  return { requests, gateway: gateway as unknown as ExternalSessionGateway }
}

describe('claude argv', () => {
  it('passes the pinned model as a flag before the prompt terminator', () => {
    const argv = claudeTurnArgv('-looks-like-a-flag', undefined, 'kaon/claude-opus-5-5')
    expect(argv).toContain('--model')
    expect(argv[argv.indexOf('--model') + 1]).toBe('kaon/claude-opus-5-5')
    // A dash-leading prompt is still a positional: the terminator comes last.
    expect(argv[argv.length - 2]).toBe('--')
    expect(argv[argv.length - 1]).toBe('-looks-like-a-flag')
  })

  it('keeps the CLI default when no model is pinned', () => {
    expect(claudeTurnArgv('hi')).not.toContain('--model')
    expect(claudeTurnArgv('hi', 'sess-1')).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--resume', 'sess-1', 'hi'])
  })

  it('carries the model on a continuation too', () => {
    const argv = claudeTurnArgv('again', 'sess-1', 'kaon/claude-haiku-5-5')
    expect(argv).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--model', 'kaon/claude-haiku-5-5', '--resume', 'sess-1', 'again'])
  })
})

describe('codex argv', () => {
  it('puts the override before the subcommand, in both shapes', () => {
    // `-c` is a CLI-level flag: after `exec` it would be parsed as an exec option.
    expect(codexTurnArgv('hi', undefined, 'gpt-6-astra')[0]).toBe('-c')
    expect(codexTurnArgv('hi', undefined, 'gpt-6-astra')[1]).toBe('model=gpt-6-astra')
    const resume = codexTurnArgv('again', 'thr-1', 'gpt-6-astra')
    expect(resume.slice(0, 2)).toEqual(['-c', 'model=gpt-6-astra'])
    expect(resume.slice(2, 4)).toEqual(['exec', 'resume'])
  })

  it('leaves the command unchanged without a model', () => {
    expect(codexTurnArgv('hi')).toEqual(['exec', '--json', '--approve-for-me', '--skip-git-repo-check', 'hi'])
  })
})

describe('spawn argv actually carries the model', () => {
  // The builder accepting a model is not the same as the spawn passing it: the first
  // version of this change had the flag in the builder and never sent it, so every
  // call silently ran the CLI's own default. These assert the argv the process gets.
  const base = { prompt: 'hi', cwd: '/tmp' }

  it('claude spawn argv carries --model and keeps the prompt last', () => {
    const argv = claudeSpawnArgv('/usr/bin/claude', { ...base, model: 'kaon/claude-opus-5-5' })
    expect(argv[0]).toBe('/usr/bin/claude')
    expect(argv).toContain('--model')
    expect(argv[argv.indexOf('--model') + 1]).toBe('kaon/claude-opus-5-5')
    expect(argv[argv.length - 1]).toBe('hi')
  })

  it('codex spawn argv carries the model override before the subcommand', () => {
    const argv = codexSpawnArgv('/usr/bin/codex', { ...base, model: 'gpt-6-astra' })
    expect(argv.slice(1, 3)).toEqual(['-c', 'model=gpt-6-astra'])
    expect(argv.slice(3, 5)).toEqual(['exec', '--json'])
  })

  it('omits the flag entirely when the turn carries no model', () => {
    expect(claudeSpawnArgv('/usr/bin/claude', base)).not.toContain('--model')
    expect(codexSpawnArgv('/usr/bin/codex', base)).not.toContain('model=')
  })
})

describe('delegation tool model parameter', () => {
  it('turns the configured catalogue into described oneOf branches', () => {
    const { gateway } = recordingGateway()
    const tool = makeDelegationTool('claude', () => gateway, 'subagent_claude_code', CATALOGUE)
    const model = ((tool.parameters as Record<string, unknown>)['properties'] as Record<string, unknown>)['model'] as {
      oneOf: Array<{ const: string; description: string }>
    }
    expect(model.oneOf.map(branch => branch.const)).toEqual(['kaon/claude-sonnet-5-5', 'kaon/claude-opus-5-5'])
    expect(model.oneOf[1]?.description).toContain('expensive')
  })

  it('keeps a free string when the row declares no catalogue', () => {
    const { gateway } = recordingGateway()
    const tool = makeDelegationTool('codex', () => gateway, 'subagent_codex')
    const model = ((tool.parameters as Record<string, unknown>)['properties'] as Record<string, unknown>)['model'] as { type?: string }
    expect(model.type).toBe('string')
  })

  it('sends the chosen model to the engine, and omits it when unset', async () => {
    const { gateway, requests } = recordingGateway()
    const tool = makeDelegationTool('claude', () => gateway, 'subagent_claude_code', CATALOGUE)
    await tool.execute({ prompt: 'hi', model: 'kaon/claude-opus-5-5' }, execContext() as never)
    await tool.execute({ prompt: 'hi' }, execContext() as never)
    expect(requests[0]?.['model']).toBe('kaon/claude-opus-5-5')
    // Absent, not empty: the adapter must not send a blank --model.
    expect('model' in (requests[1] ?? {})).toBe(false)
  })

  it('falls back to the configured default model when the caller omits one', async () => {
    const { gateway, requests } = recordingGateway()
    const tool = makeDelegationTool('claude', () => gateway, 'subagent_claude_code', CATALOGUE, 'kaon/claude-opus-5-5')
    await tool.execute({ prompt: 'hi' }, execContext() as never)
    await tool.execute({ prompt: 'hi', model: 'kaon/claude-sonnet-5-5' }, execContext() as never)
    expect(requests[0]?.['model']).toBe('kaon/claude-opus-5-5')
    // An explicit choice still wins over the default.
    expect(requests[1]?.['model']).toBe('kaon/claude-sonnet-5-5')
  })

  it('trims a padded id and ignores a blank one where the parameter is free-form', async () => {
    // With a catalogue the schema rejects a padded id before the tool runs, which
    // is the stricter behaviour; the trim only matters for a free-form field.
    const { gateway, requests } = recordingGateway()
    const tool = makeDelegationTool('codex', () => gateway, 'subagent_codex')
    await tool.execute({ prompt: 'hi', model: '  gpt-6-astra  ' }, execContext() as never)
    await tool.execute({ prompt: 'hi', model: '   ' }, execContext() as never)
    expect(requests[0]?.['model']).toBe('gpt-6-astra')
    expect('model' in (requests[1] ?? {})).toBe(false)
  })
})
