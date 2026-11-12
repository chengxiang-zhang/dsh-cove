/** Bind an attempt only after the transport completes its required session setup. */
import type { ExecutorCreateRequest, ExecutorCreateResult, ExecutorTransport } from './types.ts'

/**
 * Existence and cwd-conflict text do not attest ownership or completed preset/model
 * setup. This interface has no positive reattachment proof, so every refusal is
 * preserved. In particular, never cancel another session or prompt a default route
 * merely because the requested id exists after a partially successful create.
 */
export async function ensureExecutorSession(
  transport: ExecutorTransport,
  req: ExecutorCreateRequest,
): Promise<ExecutorCreateResult> {
  return await transport.create(req)
}
