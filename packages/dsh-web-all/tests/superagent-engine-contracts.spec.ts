import { expect, it } from 'vitest'
import {
  isolatedCodexArgs,
  assertCodexInventory
} from '../src/host/services/superagent/executors/engines/codex.ts'
it('requires effective disabled execution routes and an empty external tool inventory, rather than trusting startup flags', () => {
  const features = {
    shell_tool: false,
    code_mode_host: false,
    apps: false,
    plugins: false,
    remote_plugin: false,
    multi_agent: false
  }
  expect(() => assertCodexInventory({ config: { features } }, { data: [] })).not.toThrow()
  expect(() =>
    assertCodexInventory({ config: { features: { ...features, code_mode_host: true } } }, { data: [] })
  ).toThrow('CODEX_TOOL_ISOLATION_UNPROVEN')
  expect(() =>
    assertCodexInventory({ config: { features } }, { data: [{ name: 'external', tools: { exec: {} } }] })
  ).toThrow('CODEX_EXTERNAL_TOOLS_PRESENT')
  expect(() => assertCodexInventory({ config: { features } }, { data: [], nextCursor: 'remaining' })).toThrow(
    'CODEX_INVENTORY_INCOMPLETE'
  )
  expect(isolatedCodexArgs()).toContain('code_mode_host')
  expect(isolatedCodexArgs()).toContain('app-server')
})

it('keeps Claude read-only probes distinct from writable worker qualification', async () => {
  const { ClaudeCodeNativeExecutor, claudeCodeCapabilities } =
    await import('../src/host/services/superagent/executors/engines/claude-code.ts')
  const engine = new ClaudeCodeNativeExecutor({
    host_ref: 'host',
    engine_ref: 'claude',
    runtime_namespace: 'isolated',
    native_session_id: 'session'
  })
  await expect(
    engine.execute(
      {
        request_id: 'request',
        assignment_revision: 1,
        payload_ref: 'payload',
        payload_digest: 'digest',
        text: 'write'
      },
      new AbortController().signal
    )
  ).rejects.toThrow('CLAUDE_NATIVE_WORKER_NOT_QUALIFIED')
  expect(claudeCodeCapabilities.supported).not.toContain('controlled-native-worker')
  expect(claudeCodeCapabilities.gaps.every((gap) => gap.owner.length > 0)).toBe(true)
})
