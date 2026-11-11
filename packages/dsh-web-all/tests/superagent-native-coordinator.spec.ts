import { expect, it } from 'vitest'
import { CodexCoordinatorRuntime } from '../src/host/services/superagent/executors/engines/codex-coordinator.ts'
it('refuses a coordinator backed by business tools or missing structured output', () => {
  expect(
    () =>
      new CodexCoordinatorRuntime({ options: { dynamicTools: [{}], outputSchema: {} } } as never, (x) => x)
  ).toThrow('COORDINATOR_BUSINESS_TOOLS_FORBIDDEN')
  expect(() => new CodexCoordinatorRuntime({ options: { dynamicTools: [] } } as never, (x) => x)).toThrow(
    'COORDINATOR_SCHEMA_REQUIRED'
  )
})
