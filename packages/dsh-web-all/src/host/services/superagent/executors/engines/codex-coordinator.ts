import { createHash } from 'node:crypto'
import type { InputRecord } from '../native/adapter.ts'
import { CodexNativeExecutor } from './codex.ts'
export interface CoordinatorInput {
  request_id: string
  assignment_revision: number
  text: string
}
/** Structured proposal runtime only. The caller's validator owns proposal semantics and execution. */
export class CodexCoordinatorRuntime<Proposal> {
  constructor(
    private readonly engine: CodexNativeExecutor,
    private readonly validate: (value: unknown) => Proposal
  ) {
    if (engine.options.dynamicTools?.length) throw new Error('COORDINATOR_BUSINESS_TOOLS_FORBIDDEN')
    if (!engine.options.outputSchema) throw new Error('COORDINATOR_SCHEMA_REQUIRED')
  }
  async run(input: CoordinatorInput, signal: AbortSignal): Promise<Proposal> {
    const record: InputRecord = {
      ...input,
      payload_digest: createHash('sha256').update(input.text).digest('hex'),
      payload_ref: 'coordinator:' + input.request_id
    }
    await this.engine.execute(record, signal)
    while (Date.now() < this.engine.io.launch.expiresAt) {
      if (signal.aborted) {
        await this.engine.cancel()
        throw new Error('COORDINATOR_CANCELLED')
      }
      const receipt = await this.engine.receiptFor(record)
      if (receipt.status === 'consumed') {
        const turn = this.engine.turns().find((t) => t.id === receipt.consumption.turn_id)
        if (turn?.status === 'completed') {
          const answer = turn.items.filter((item) => item.type === 'agentMessage').at(-1)?.text
          if (!answer) throw new Error('COORDINATOR_OUTPUT_MISSING')
          return this.validate(JSON.parse(answer))
        }
        if (turn && ['failed', 'interrupted'].includes(turn.status))
          throw new Error('COORDINATOR_TURN_FAILED')
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error('COORDINATOR_OUTCOME_UNKNOWN')
  }
}
