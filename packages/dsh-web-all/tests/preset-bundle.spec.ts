import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeTest = process.env.DSH_RUNTIME_VERIFY === '1' ? it : it.skip

const repoRoot = resolve(packageRoot, '..', '..')

/** The endpoint the preset must carry: the machine's value when present, else the template's. */
function expectedHiopenBaseUrl(): string {
  const explicit = process.env.DSH_COVE_CONFIG
  const local = resolve(repoRoot, 'config/deployment.local.json')
  const file = explicit ? resolve(explicit) : existsSync(local) ? local : resolve(repoRoot, 'config/deployment.example.json')
  return (JSON.parse(readFileSync(file, 'utf8')) as { llm: { hiopen: { baseUrl: string } } }).llm.hiopen.baseUrl
}

async function listSkillDirectories(): Promise<string[]> {
  const entries = await readdir(resolve(packageRoot, 'presets/code-vibe/skills'), { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

describe('bundled code-vibe preset', () => {
  it('publishes the preset patches after the entity runtime patch', async () => {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
    expect(manifest.dsh.bundle.patch).toEqual([
      './cordis.patch.yml',
      './presets/hiopen.patch.yml',
      './presets/code-vibe.patch.yml',
    ])
    expect(manifest.files).toContain('presets')
    expect(manifest.dsh.engines.dsh).toBe('>=0.2.0-rc.2')
  })

  it('ships a credential-free HiOpen provider catalog for agent models', async () => {
    const source = await readFile(resolve(packageRoot, 'presets/hiopen.patch.yml'), 'utf8')
    const patch = parse(source)
    const deepseek = patch.find((row: { id?: string }) => row.id === 'llm-deepseek')
    const piAi = patch.find((row: { id?: string }) => row.id === 'llm-pi-ai')
    const hiopen = piAi.config.providers.hiopen

    expect(deepseek.config.baseURL).toBe(expectedHiopenBaseUrl())
    expect(hiopen).toMatchObject({
      displayName: 'HiOpen',
      apiKeyEnv: 'HIOPEN_API_KEY',
      api: 'openai-completions',
      baseURL: expectedHiopenBaseUrl(),
      defaultContextWindow: 262144,
      defaultMaxTokens: 32768,
      defaultInput: ['text'],
    })
    expect(source).not.toMatch(/sk-[A-Za-z0-9]{16,}/u)

    // The curated catalog dropped three hiopen routes whose upstream leaks
    // thinking text (including <calls> tool plans) into the content stream
    // instead of the reasoning_content field, which pi-ai cannot strip:
    //   - deepseek-v4.1-flash (prefixless alternate route -> agnes-3.0-flash)
    //   - MiniMax-M3, MiniMax-M2.7-highspeed (thinking-as-text in content)
    const models = new Map(hiopen.models.map((model: { id: string }) => [model.id, model]))
    expect([...models.keys()]).toEqual([
      'deepseek-ai/deepseek-v4.1-flash',
      'deepseek-v4-flash-0731',
      'z-ai/glm-5.3',
      'z-ai/glm-5.3-flash',
      'openai/gpt-oss-20b',
      'meta/llama-3.2-90b-vision-instruct',
    ])
    expect(models.get('deepseek-ai/deepseek-v4.1-flash')).toMatchObject({
      contextWindow: 1048576,
      maxTokens: 262144,
      input: ['text', 'image'],
    })
    expect(models.get('z-ai/glm-5.3')).toMatchObject({
      contextWindow: 1048576,
      maxTokens: 131072,
      input: ['text'],
      reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
    })
    expect(models.get('meta/llama-3.2-90b-vision-instruct')).toMatchObject({
      contextWindow: 131072,
      maxTokens: 8192,
      input: ['text', 'image'],
      reasoningEfforts: false,
    })
    expect(models.has('MiniMax-M3')).toBe(false)
    expect(models.has('MiniMax-M2.7-highspeed')).toBe(false)
    expect(models.has('deepseek-v4.1-flash')).toBe(false)
  })

  it('declares code-vibe through the DSH 0.2 preset plugin', async () => {
    const source = await readFile(resolve(packageRoot, 'presets/code-vibe.patch.yml'), 'utf8')
    const patch = parse(source, {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
    })
    const row = patch[0].insert[0]
    expect(row).toMatchObject({
      id: 'preset-code-vibe',
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id: 'code-vibe',
        name: '许愿式编程',
        order: 5,
      },
    })
    expect(row.config.plugins).toEqual(expect.any(Array))
    expect(row.config.plugins.length).toBeGreaterThan(15)
    expect(patch).toHaveLength(1)
    expect(source).not.toContain('agent-preset-registry')
    expect(source).not.toMatch(/default:\s*code-vibe/u)
  })

  it('keeps the DSH 0.2 standard command, presentation, and disabled provider contracts', async () => {
    const source = await readFile(resolve(packageRoot, 'presets/code-vibe.patch.yml'), 'utf8')
    expect(source).toContain("- id: command-goal")
    expect(source).toContain("name: '@deepseek-ai/dsh-command-goal'")
    expect(source).toContain("- id: present")
    expect(source).toContain("name: '@deepseek-ai/dsh-tool-present'")
    expect(source).toContain('backgroundMode: one-shot')
    expect(source).not.toContain('enableRunInBackground')
  })

  it('resolves packaged skills without referring to the retired user preset directory', async () => {
    const source = await readFile(resolve(packageRoot, 'presets/code-vibe.patch.yml'), 'utf8')
    expect(source).toContain("createRequire(baseUrl).resolve('@dsh-cove/dsh-web-all/package.json')")
    expect(source).toContain("'presets/code-vibe/skills'")
    expect(source).not.toContain('.agent-presets')
  })

  it('ships the curated skill set without backup or cache debris', async () => {
    const skills = await listSkillDirectories()
    expect(skills).toContain('wish-programming')
    expect(skills).toContain('agent-operation')
    expect(skills).toContain('quality-review')
    expect(skills).toContain('frontend-design')
    expect(skills).not.toContain('__pycache__')
    expect(skills).not.toContain('backups')
    expect(await readFile(resolve(packageRoot, 'presets/code-vibe/skills/wish-programming/SKILL.md'), 'utf8')).toContain('# Wish Programming')
  })

  it('runs the preset budget gate from packaged assets with a clean home', async () => {
    const home = await mkdtemp(resolve(tmpdir(), 'dsh-code-vibe-test-'))
    try {
      const script = resolve(packageRoot, 'presets/code-vibe/skills/wish-programming/scripts/verify_preset_budgets.py')
      const { stdout, stderr } = await execFileAsync('python3', [script], {
        env: { ...process.env, HOME: home },
      })
      expect(stdout).toContain('verify_preset_budgets OK')
      expect(stderr).not.toContain('.agent-presets')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('ships upstream provenance without machine-specific checkout paths', async () => {
    const upstream = await readFile(resolve(packageRoot, 'presets/code-vibe/skills/UPSTREAM.md'), 'utf8')
    const notices = await readFile(resolve(packageRoot, 'presets/code-vibe/THIRD_PARTY_NOTICES.md'), 'utf8')
    expect(upstream).not.toMatch(/~\/code|\/home\//u)
    expect(upstream).toContain('https://github.com/chengxiang-zhang/sdd-vibe-coding')
    expect(notices).toContain('Copyright (c) 2026 DeepSeek')
    expect(notices).toContain('Copyright (c) 2026 Vibe Coding contributors')
    expect(notices.match(/Permission is hereby granted/gmu)).toHaveLength(2)
  })

  runtimeTest('mounts the single runtime row and scoped packaged skill in DSH 0.2', async () => {
    const home = await mkdtemp(resolve(tmpdir(), 'dsh-code-vibe-runtime-'))
    const profile = resolve(home, 'profiles/probe')
    try {
      await mkdir(resolve(profile, 'node_modules/@dsh-cove'), { recursive: true })
      await symlink(packageRoot, resolve(profile, 'node_modules/@dsh-cove/dsh-web-all'))
      await writeFile(resolve(profile, 'package.json'), `${JSON.stringify({
        name: 'dsh-profile-code-vibe-runtime-test',
        private: true,
        dsh: {
          profile: {
            bundles: [
              '@deepseek-ai/dsh-base',
              '@deepseek-ai/dsh-web-app',
              '@dsh-cove/dsh-web-all',
            ],
            patchReload: 'startup',
          },
        },
      }, null, 2)}\n`)
      await writeFile(resolve(profile, 'cordis.patch.yml'), [
        '- id: web-all',
        '  disabled: true',
        '',
        '- insert:',
        '    - id: code-vibe-roster-probe',
        "      name: './roster-probe.mjs'",
        '      inject: [agentPresets, skills]',
        '',
      ].join('\n'))
      await symlink(
        resolve(packageRoot, 'tests/fixtures/code-vibe-roster-probe.mjs'),
        resolve(profile, 'roster-probe.mjs'),
      )
      const command = process.env.DSH_CMD ?? 'dsh'
      let stdout = ''
      try {
        await execFileAsync('timeout', [
          '12', command, '--profile', 'probe', '--host', '127.0.0.1', '--port', '0', '--no-open',
        ], { env: { ...process.env, DSH_HOME: home }, maxBuffer: 4 * 1024 * 1024 })
      } catch (error) {
        const result = error as Error & { code?: number; stdout?: string; stderr?: string }
        expect(result.code, result.stderr).toBe(124)
        expect(result.stderr ?? '').toBe('')
        stdout = result.stdout ?? ''
      }
      const line = stdout.split('\n').find(value => value.startsWith('[CODE_VIBE_RUNTIME] '))
      expect(line).toBeDefined()
      const evidence = JSON.parse(line!.slice('[CODE_VIBE_RUNTIME] '.length))
      const failed = evidence.composition.rows.filter((row: { enabled: boolean; fiberState?: number }) => row.enabled && row.fiberState !== 2)
      expect(evidence.composition.isDefault).toBe(false)
      expect(failed).toEqual([])
      expect(evidence.skills).toEqual(['agent-operation', 'frontend-design', 'quality-review', 'wish-programming'])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 20_000)

  it('documents the added roster option without changing the default', async () => {
    const english = await readFile(resolve(packageRoot, 'README.md'), 'utf8')
    const chinese = await readFile(resolve(packageRoot, 'README.zh.md'), 'utf8')
    expect(english).toContain('Wish Programming')
    expect(english).toContain('remains the default')
    expect(chinese).toContain('许愿式编程')
    expect(chinese).toContain('仍为默认')
  })
})
