import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  ghPrCreateArgv, normalizePrCreateInput, parseGhPrCreateOutput,
} from '../src/core/worktree/pr-create.ts'
import { makeWorktreeRoutes, type WorktreeDeps } from '../src/host/services/worktree/routes.ts'
import type { RunCommand } from '../src/host/services/worktree/run-command.ts'

interface RouteResponse {
  status: number
  body: Record<string, unknown>
}

function makeRequest(body: unknown, remoteAddress = '127.0.0.1', method = 'POST'): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  Object.assign(req, {
    method,
    url: '/worktree/pr-create',
    socket: { remoteAddress },
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify(body))
    },
  })
  return req
}

function makeResponse(): { res: ServerResponse; result: Promise<RouteResponse> } {
  let status = 0
  let resolveResult!: (value: RouteResponse) => void
  const result = new Promise<RouteResponse>((resolve) => { resolveResult = resolve })
  const res = {
    writeHead(code: number) { status = code; return this },
    end(chunk?: string | Buffer) {
      const text = chunk === undefined ? '{}' : chunk.toString()
      resolveResult({ status, body: JSON.parse(text) as Record<string, unknown> })
      return this
    },
  } as unknown as ServerResponse
  return { res, result }
}

async function callPrCreate(
  body: unknown,
  options: { remoteAddress?: string; method?: string; deps?: Partial<WorktreeDeps> } = {},
): Promise<RouteResponse> {
  const deps: WorktreeDeps = {
    resolveProjectRoot: cwd => cwd.startsWith('/repo') ? '/repo' : undefined,
    runCommand: async () => ({ stdout: 'https://github.com/acme/repo/pull/42\n', stderr: '' }),
    logger: { warn: vi.fn() },
    ...options.deps,
  }
  const route = makeWorktreeRoutes(deps).find(candidate => candidate.path === '/worktree/pr-create')
  if (route === undefined) throw new Error('pr-create route missing')
  const { res, result } = makeResponse()
  await route.handler(makeRequest(body, options.remoteAddress, options.method), res)
  return result
}

function commandError(message: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), fields)
}

describe('worktree pr-create input and argv', () => {
  it('builds an argv-only gh invocation with base, head, draft, and literal user content', () => {
    const input = normalizePrCreateInput({
      cwd: '/repo/wt',
      branch: 'feature/safe',
      title: 'Ship $(touch /tmp/nope); still literal',
      body: 'Body `whoami` && echo nope\nsecond line',
      base: 'dev',
      head: 'alice:feature/safe',
      draft: true,
    })
    expect(input.ok).toBe(true)
    if (!input.ok) return
    const { cwd: _cwd, branch: _branch, ...prInput } = input.value
    expect(ghPrCreateArgv(prInput)).toEqual([
      'pr', 'create',
      '--title', 'Ship $(touch /tmp/nope); still literal',
      '--body', 'Body `whoami` && echo nope\nsecond line',
      '--head', 'alice:feature/safe',
      '--base', 'dev',
      '--draft',
    ])
  })

  it('retains legacy repoPath/name/baseRef fields and defaults title/body/head', () => {
    expect(normalizePrCreateInput({ repoPath: '/repo/wt', name: 'feature/legacy', baseRef: 'dev' })).toEqual({
      ok: true,
      value: {
        cwd: '/repo/wt',
        branch: 'feature/legacy',
        title: 'feature/legacy',
        body: '',
        base: 'dev',
        head: 'feature/legacy',
        draft: false,
      },
    })
  })

  it('rejects option-like and malformed refs plus unsafe title/body bytes', () => {
    expect(normalizePrCreateInput({ cwd: 42 as never, branch: 'feature/x' })).toMatchObject({ ok: false })
    expect(normalizePrCreateInput({ cwd: '/repo', branch: 42 as never })).toMatchObject({ ok: false })
    expect(normalizePrCreateInput({ cwd: '/repo', branch: '--repo=other' })).toMatchObject({ ok: false })
    expect(normalizePrCreateInput({ cwd: '/repo', branch: 'feature/x', base: 'bad ref' })).toMatchObject({ ok: false })
    expect(normalizePrCreateInput({ cwd: '/repo', branch: 'feature/x', head: 'owner:--repo=other' })).toMatchObject({ ok: false })
    expect(normalizePrCreateInput({ cwd: '/repo', branch: 'feature/x', title: 'line one\nline two' })).toMatchObject({ ok: false })
    expect(normalizePrCreateInput({ cwd: '/repo', branch: 'feature/x', body: 'bad\0body' })).toMatchObject({ ok: false })
  })

  it('parses the PR URL and number from gh output', () => {
    expect(parseGhPrCreateOutput('Created pull request: https://github.com/acme/repo/pull/123\n')).toEqual({
      url: 'https://github.com/acme/repo/pull/123',
      number: 123,
    })
  })
})

describe('POST /worktree/pr-create', () => {
  it('keeps the loopback guard before reading input or running gh', async () => {
    const runner = vi.fn<RunCommand>()
    const response = await callPrCreate({ cwd: '/repo', branch: 'feature/x' }, {
      remoteAddress: '192.0.2.10',
      deps: { runCommand: runner },
    })
    expect(response).toMatchObject({ status: 403, body: { error: 'forbidden: loopback-only' } })
    expect(runner).not.toHaveBeenCalled()
  })

  it('resolves the project root and passes exact argv to the injected runner', async () => {
    const resolveProjectRoot = vi.fn(() => '/repo')
    const runner = vi.fn<RunCommand>(async () => ({
      stdout: 'https://github.com/acme/repo/pull/42\n',
      stderr: '',
    }))
    const response = await callPrCreate({
      cwd: '/repo/packages/app',
      branch: 'feature/safe',
      title: 'Literal ; $(no shell)',
      body: 'Body && still one argv',
      base: 'dev',
      head: 'feature/safe',
      draft: true,
    }, { deps: { resolveProjectRoot, runCommand: runner } })

    expect(resolveProjectRoot).toHaveBeenCalledWith('/repo/packages/app')
    expect(runner).toHaveBeenCalledWith('gh', [
      'pr', 'create', '--title', 'Literal ; $(no shell)', '--body', 'Body && still one argv',
      '--head', 'feature/safe', '--base', 'dev', '--draft',
    ], { cwd: '/repo', timeoutMs: 30_000, maxBuffer: 4 * 1024 * 1024 })
    expect(response).toEqual({
      status: 200,
      body: {
        ok: true,
        value: {
          url: 'https://github.com/acme/repo/pull/42',
          number: 42,
          prUrl: 'https://github.com/acme/repo/pull/42',
          method: 'api',
        },
        url: 'https://github.com/acme/repo/pull/42',
        number: 42,
        prUrl: 'https://github.com/acme/repo/pull/42',
        method: 'api',
      },
    })
  })

  it.each([
    ['gh missing', commandError('spawn gh ENOENT', { code: 'ENOENT' }), 503, 'gh-not-installed'],
    ['not authenticated', commandError('HTTP 401: Bad credentials; run gh auth login', { code: 1, stderr: 'not logged in to any GitHub hosts' }), 401, 'gh-not-authenticated'],
    ['PR exists', commandError('failed', { code: 1, stderr: 'a pull request for branch "feature/x" into branch "dev" already exists' }), 409, 'pr-already-exists'],
    ['timeout', commandError('killed', { code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM' }), 504, 'timeout'],
  ] as const)('classifies %s', async (_label, error, status, code) => {
    const response = await callPrCreate({ cwd: '/repo', branch: 'feature/x' }, {
      deps: { runCommand: async () => { throw error } },
    })
    expect(response.status).toBe(status)
    expect(response.body).toMatchObject({ ok: false, code })
  })

  it('returns a stable generic gh failure and rejects output without a PR URL', async () => {
    const failed = await callPrCreate({ cwd: '/repo', branch: 'feature/x' }, {
      deps: { runCommand: async () => { throw commandError('network failed', { code: 1, stderr: 'network failed' }) } },
    })
    expect(failed).toMatchObject({ status: 502, body: { ok: false, code: 'gh-failed' } })

    const malformed = await callPrCreate({ cwd: '/repo', branch: 'feature/x' }, {
      deps: { runCommand: async () => ({ stdout: 'done without a URL', stderr: '' }) },
    })
    expect(malformed).toMatchObject({ status: 502, body: { ok: false, code: 'invalid-gh-response' } })
  })
})
