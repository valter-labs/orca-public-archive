import { RuntimeRpcEnvelopeSchema } from '../../../shared/runtime-rpc-envelope'
import { callAbortableRuntimeEnvironment } from './abortable-runtime-environment-call'

export async function callRuntimeEnvironmentWithRevision(args: {
  environmentId: string
  method: string
  params: unknown
  timeoutMs?: number
  signal?: AbortSignal
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
  orchestrationRequestId?: string
}): Promise<unknown> {
  if (args.signal && args.orchestrationRequestId) {
    throw new Error('Durable runtime calls cannot use the subscription abort bridge.')
  }
  const response = args.signal
    ? await callAbortableRuntimeEnvironment(
        args.environmentId,
        args.method,
        args.params,
        args.timeoutMs,
        args.signal,
        args.expectedEnvironmentPairingRevision,
        args.expectedEnvironmentRuntimeId
      )
    : await window.api.runtimeEnvironments.call({
        selector: args.environmentId,
        method: args.method,
        params: args.params,
        timeoutMs: args.timeoutMs,
        expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision,
        expectedEnvironmentRuntimeId: args.expectedEnvironmentRuntimeId,
        ...(args.orchestrationRequestId
          ? { orchestrationRequestId: args.orchestrationRequestId }
          : {})
      })
  const ownerResponse = args.expectedEnvironmentRuntimeId
    ? RuntimeRpcEnvelopeSchema.safeParse(response)
    : null
  if (
    args.expectedEnvironmentRuntimeId &&
    (!ownerResponse?.success ||
      !('_meta' in ownerResponse.data) ||
      ownerResponse.data._meta?.runtimeId !== args.expectedEnvironmentRuntimeId)
  ) {
    throw new Error('runtime_environment_runtime_changed')
  }
  return response
}
