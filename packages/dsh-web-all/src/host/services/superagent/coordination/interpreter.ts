import { createHash } from 'node:crypto'
import type { ManagedLedger } from '../kernel/managed-ledger.ts'
import { OperationDomainBusy } from '../kernel/coordination-ledger.ts'
import type { Ref, Json } from '../protocol/managed-work.ts'
import { assertJson } from '../protocol/managed-work.ts'
import type { CoordinationService } from './intake.ts'

export interface InterpreterOptions {
  /** Trusted composition derives these from actual seats/resources, never model-supplied keys. */
  domains?(proposal: Json): string[] | undefined
  executionSlots?(proposal: Json): string[]
  /** Synchronous, read-only host admission; no intent or domain is claimed on refusal. */
  preflight?(proposal: Json): void
}

/** Input idempotency and unresolved-effect exclusion are separate durable boundaries. */
export function createProposalInterpreter(ledger: ManagedLedger, coordination: CoordinationService, execute: (proposal: Json, operationId: string) => Promise<Json>, options: InterpreterOptions = {}) {
  const domains = options.domains ?? ((proposal: Json) => ['look','wait'].includes(String((proposal as any)?.kind)) ? undefined : ['unscoped-effects'])
  const unknown = (operation: string): Json => ({ status: 'unknown', operation, reason: 'Await trusted native or controlled outcome reconciliation before another effect in this domain' })
  return {
    async apply(inputRef: string, proposals: Json[], scopes: Ref[]): Promise<Json[]> {
      assertJson(proposals)
      if (!inputRef || !proposals.length || proposals.length > 20) throw new Error('PROPOSAL_BATCH_LIMIT')
      const results: Json[] = []
      for (const [index, proposal] of proposals.entries()) {
        const key = 'proposal:' + createHash('sha256').update(inputRef + ':' + index).digest('hex'), operationId = key + ':operation'
        const old = ledger.get(key)
        if (old && JSON.stringify(old.data.payload) !== JSON.stringify(proposal)) throw new Error('PROPOSAL_IDENTITY_CONFLICT')
        const complete = ledger.get(key + ':result'), operation = ledger.get(operationId)
        if (complete) { results.push(complete.data.payload!); continue }
        if (operation?.data.state === 'completed') { results.push(operation.data.result!); continue }
        if (old || operation) { results.push(unknown(operationId)); continue }
        const admission: unknown = options.preflight?.(proposal)
        if (admission && typeof (admission as { then?: unknown }).then === 'function') throw new Error('SYNCHRONOUS_PREFLIGHT_REQUIRED')
        const domainKeys = domains(proposal)
        if (domainKeys) {
          // Pre-fix unknown intents remain excluded too; installing the fix must not erase them.
          const historical = ledger.snapshot('coordination_runtime_event').find(o => o.data.event === 'proposal_started' && !ledger.get(o.id + ':result') && !ledger.get(o.id + ':operation') && domains(o.data.payload!)?.some(key => domainKeys.includes(key)))
          if (historical) { results.push(unknown(historical.id)); continue }
          try { coordination.host.claimOperation({ id: operationId, inputRef, proposal, domainKeys, scopeRefs: scopes, executionSlots: options.executionSlots?.(proposal) ?? [] }) }
          catch (error) { if (error instanceof OperationDomainBusy) { results.push(unknown(error.operation.id)); continue } throw error }
        }
        coordination.host.recordRuntimeEvent(key, 'proposal_started', proposal, scopes, [inputRef])
        try {
          const result = await execute(proposal, operationId)
          if (domainKeys && ledger.get(operationId)?.data.state !== 'completed') { results.push(unknown(operationId)); continue }
          coordination.host.recordRuntimeEvent(key + ':result', 'proposal_result', result, scopes, [inputRef])
          results.push(result)
        } catch (error) {
          coordination.host.recordRuntimeEvent(key + ':unknown', 'proposal_unknown', { reason: String(error), operation: operationId }, [], [inputRef])
          throw error
        }
      }
      return results
    },
  }
}
