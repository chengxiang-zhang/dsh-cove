import type { ActionSpec } from '../kernel/actions.ts'
import { deliveryActionSpec, type DeliveryStep } from '../protocol/delivery.ts'
export { LOCAL_GIT_DELIVERY } from '../protocol/delivery.ts'
/** Host-only fixed descriptor; no shell or model-selected Git arguments. */
export function prepareDeliveryStep(step: DeliveryStep): ActionSpec { return deliveryActionSpec(step) }
