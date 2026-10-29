import { describe, expect, it, vi } from 'vitest'
import {
  cherryPickArgv, commitDiffArgv, discardFileArgv, graphLogArgv, revertArgv,
  validateObjectId, validateRepoRelativePath, verifyCommitArgv, verifyTrackedPathArgv,
} from '../src/core/git-graph/commands.ts'
import { GitService, classifyApplyFailure, type GitRunResult, type GitRunner } from '../src/host/services/git-graph/service.ts'
import { registerGitRoutes } from '../src/host/services/git-graph/routes.ts'

class MockRunner implements GitRunner {
  calls: string[][] = []
  constructor(private readonly reply: (argv: readonly string[]) => GitRunResult) {}
  async run(argv: readonly string[]): Promise<GitRunResult> { this.calls.push([...argv]); return this.reply(argv) }
}
const ok = (stdout = ''): GitRunResult => ({ exitCode: 0, stdout, stderr: '' })

describe('git workbench argv', () => {
  it('uses fixed argv and separators for refs and paths', () => {
    expect(graphLogArgv(31, 30).slice(-4)).toEqual(['--max-count', '31', '--skip', '30'])
    expect(commitDiffArgv('abcdef1')).toEqual(['show', '--format=fuller', '--stat', '--patch', '--no-ext-diff', '--no-color', '--find-renames', 'abcdef1', '--'])
    expect(verifyCommitArgv('abcdef1')).toEqual(['cat-file', '-e', 'abcdef1^{commit}'])
    expect(verifyTrackedPathArgv('a b.ts')).toEqual(['ls-files', '--error-unmatch', '--', 'a b.ts'])
    expect(discardFileArgv('a b.ts')).toEqual(['restore', '--source=HEAD', '--staged', '--worktree', '--', 'a b.ts'])
    expect(revertArgv('abcdef1')).toEqual(['revert', '--no-edit', '--', 'abcdef1'])
    expect(cherryPickArgv('abcdef1')).toEqual(['cherry-pick', '--', 'abcdef1'])
  })

  it('rejects option-like refs and paths outside the repository', () => {
    expect(validateObjectId('--help')).toBe('leading-dash')
    expect(validateObjectId('abcdef1')).toBeNull()
    expect(validateRepoRelativePath('../outside')).toBe('unsafe-component')
    expect(validateRepoRelativePath('/outside')).toBe('absolute-path')
    expect(validateRepoRelativePath('src/a.ts')).toBeNull()
  })
})

describe('GitService guarded operations', () => {
  it('paginates history with an opaque offset cursor', async () => {
    const runner = new MockRunner(argv => {
      if (argv[0] === 'rev-parse' && argv[1] === '--show-toplevel') return ok('/repo\n')
      if (argv[0] === 'rev-parse' && argv[1] === '--abbrev-ref') return ok('dev\n')
      if (argv[0] === 'log') return ok('abcdef123456\0\0Ada\01700000000\0\0one\x1e')
      return ok()
    })
    const service = new GitService(runner, async () => ({ ok: true, canonical: '/repo' }))
    await expect(service.graph('/repo', 30, '60')).resolves.toMatchObject({ branch: 'dev', hasMore: false })
    expect(runner.calls).toContainEqual(graphLogArgv(31, 60))
  })

  it('workspace-gates before commit verification', async () => {
    const runner = new MockRunner(() => ok())
    const service = new GitService(runner, async () => ({ ok: false, error: { code: 'workspace-unknown', message: 'no' } }))
    await expect(service.revert('/outside', 'abcdef1')).resolves.toMatchObject({ ok: false, error: { code: 'workspace-unknown' } })
    expect(runner.calls).toEqual([])
  })

  it('blocks cherry-pick when the mutation guard sees conflicts', async () => {
    const runner = new MockRunner(argv => {
      if (argv[0] === 'rev-parse' && argv[1] === '--show-toplevel') return ok('/repo\n')
      if (argv[0] === 'cat-file') return ok()
      if (argv[0] === 'diff') return ok('conflict.ts\n')
      if (argv[0] === 'rev-parse') return { exitCode: 1, stdout: '', stderr: '' }
      return ok()
    })
    const service = new GitService(runner, async () => ({ ok: true, canonical: '/repo' }))
    await expect(service.cherryPick('/repo', 'abcdef1')).resolves.toMatchObject({ ok: false, error: { code: 'conflicts-present' } })
    expect(runner.calls.some(argv => argv[0] === 'cherry-pick')).toBe(false)
  })

  it('discards one tracked path only and returns refreshed head', async () => {
    const runner = new MockRunner(argv => {
      if (argv[0] === 'rev-parse' && argv[1] === '--show-toplevel') return ok('/repo\n')
      if (argv[0] === 'rev-parse' && argv[1] === '--short') return ok('1234567\n')
      if (argv[0] === 'rev-parse') return { exitCode: 1, stdout: '', stderr: '' }
      return ok()
    })
    const service = new GitService(runner, async () => ({ ok: true, canonical: '/repo' }))
    await expect(service.discardFile('/repo', 'src/a.ts')).resolves.toEqual({ ok: true, value: { changed: true, kind: 'discard', head: '1234567' } })
    expect(runner.calls).toContainEqual(discardFileArgv('src/a.ts'))
  })

  it('classifies apply failures for understandable UI errors', () => {
    expect(classifyApplyFailure('error: could not apply abc\nCONFLICT (content)')).toMatchObject({ code: 'apply-conflict' })
    expect(classifyApplyFailure('The previous cherry-pick is now empty')).toMatchObject({ code: 'nothing-to-apply' })
  })
})

vi.mock('../src/client/sidebar/sidebar.module.css', () => ({ default: {} }))

describe('git route admission', () => {
  it('admits the shared fence only, never a paired-device claim', async () => {
    // Regression: the /git handler used to accept a `remoteWebUiPairing`
    // isPairedDevice claim as a second allow path. Nothing in this plugin or in
    // the installed DSH packages provides that service, so the branch could only
    // ever widen the documented rule - which is what this stub demonstrates: it
    // claims every device, and the route must still refuse.
    const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> }> = []
    const ctx = {
      logger: { warn: () => {} },
      get: (name: string) => (name === 'remoteWebUiPairing' ? { isPairedDevice: () => true } : undefined),
      webServer: {
        register: (route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
          routes.push(route)
          return () => {}
        },
      },
    }
    registerGitRoutes(ctx as never, {} as never)

    const route = routes.find((candidate) => candidate.path === '/git')
    expect(route, 'the /git route must be registered').toBeDefined()

    const state = { status: 0 }
    await route?.handler(
      // No loopback socket: the fence denies, and the pairing claim must not win.
      {
        method: 'POST',
        url: '/git/commit',
        headers: { 'content-type': 'application/json' },
        socket: undefined,
        async *[Symbol.asyncIterator]() { /* empty body */ },
      },
      { writeHead: (status: number) => { state.status = status }, end: () => {} },
    )

    expect(state.status).toBe(403)
  })
})
