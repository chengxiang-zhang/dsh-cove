import type { EngineCapabilities, InputRecord, InputReceipt, SessionIdentity } from '../native/adapter.ts'

/** Explicitly unqualified until the native request bridge and target restrictions are implemented. */
export class ClaudeCodeNativeExecutor {
  constructor(readonly identity: SessionIdentity) {}
  async execute(_input: InputRecord, _signal: AbortSignal): Promise<InputReceipt> {
    throw new Error('CLAUDE_NATIVE_WORKER_NOT_QUALIFIED')
  }
}

export const claudeCodeCapabilities: EngineCapabilities = {
  deployment_version: '2.1.322',
  evidence_refs: ['p0-probes/native-readonly.py', 'p0-probes/claude-readonly-result.json'],
  supported: ['readonly-probe', 'same-session-resume-probe', 'empty-business-tools-structured-output-probe'],
  gaps: [
    {
      capability: 'controlled-native-worker',
      owner: 'executors/engines/claude-code',
      reason: 'P0 read-only evidence does not qualify a controlled writable worker.'
    },
    {
      capability: 'native-pending-request-bridge',
      owner: 'executors/engines/claude-code',
      reason: 'No implemented per-request P2 Action bridge or target-side business-tool qualification.'
    },
    {
      capability: 'coordinator-runtime',
      owner: 'executors/engines/claude-code',
      reason: 'Structured output was probed; product runtime remains unimplemented. Codex has first priority.'
    }
  ]
}
