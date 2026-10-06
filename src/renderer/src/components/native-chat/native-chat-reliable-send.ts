import { z } from 'zod'
import { createUuidV4 } from '../../../../shared/uuid-v4'
import { callRuntimeRpc, assertRuntimeEnvironmentCapability } from '@/runtime/runtime-rpc-client'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from '@/runtime/runtime-terminal-stream'
import { useAppStore } from '../../store'
import { enqueueNativeChatPtySend } from './native-chat-pty-send-queue'
import type { NativeChatSendHandle } from './native-chat-runtime-send'
import {
  TERMINAL_PROMPT_CLEAR_INPUT_RUNTIME_CAPABILITY,
  TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { NativeChatOptimisticSendOutcome } from './native-chat-composer-types'

export type NativeChatReliableDelivery = {
  requestId: string
  environmentId: string
  runtimeId: string
  pairingRevision: number
  terminal: string
  provider: 'claude' | 'codex'
  processIncarnation?: string
  generation?: number
}

const SendReceipt = z.object({
  send: z.object({
    handle: z.string(),
    accepted: z.boolean(),
    prompt: z
      .object({
        requestId: z.string(),
        stages: z.array(z.string()),
        provider: z.string(),
        observation: z.string(),
        processIncarnation: z.string().min(1),
        generation: z.number().int().nonnegative()
      })
      .optional()
  })
})

export function readNativeChatReliableReceipt(
  receipt: unknown,
  binding: NativeChatReliableDelivery
) {
  const parsed = SendReceipt.safeParse(receipt)
  if (!parsed.success || parsed.data.send.handle !== binding.terminal) {
    return null
  }
  const { send } = parsed.data
  if (!send.accepted) {
    return { rejected: true as const }
  }
  const prompt = send.prompt
  if (
    !prompt ||
    prompt.requestId !== binding.requestId ||
    prompt.provider !== binding.provider ||
    prompt.observation !== 'supported' ||
    !prompt.stages.includes('input_accepted') ||
    (binding.processIncarnation !== undefined &&
      prompt.processIncarnation !== binding.processIncarnation) ||
    (binding.generation !== undefined && prompt.generation !== binding.generation)
  ) {
    return null
  }
  return {
    rejected: false as const,
    binding: {
      ...binding,
      processIncarnation: prompt.processIncarnation,
      generation: prompt.generation
    }
  }
}

export async function recoverNativeChatReliableDelivery(binding: NativeChatReliableDelivery) {
  const result = await callRuntimeRpc<unknown>(
    { kind: 'environment', environmentId: binding.environmentId },
    'orchestration.requestShow',
    { request: binding.requestId },
    {
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: binding.pairingRevision,
      expectedEnvironmentRuntimeId: binding.runtimeId
    }
  )
  const shown = z
    .object({
      requestId: z.string(),
      state: z.string(),
      method: z.string().optional(),
      receipt: z.unknown().optional()
    })
    .safeParse(result)
  if (
    !shown.success ||
    shown.data.requestId !== binding.requestId ||
    shown.data.method !== 'terminal.send'
  ) {
    return null
  }
  return readNativeChatReliableReceipt(shown.data.receipt, binding)
}

export function sendNativeChatReliableMessage(
  ptyId: string,
  text: string,
  provider: 'claude' | 'codex',
  callbacks: {
    pendingId: () => string | undefined
    outcome?: NativeChatOptimisticSendOutcome
    onError: (message: string) => void
  }
): NativeChatSendHandle {
  const environmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const terminal = getRemoteRuntimeTerminalHandle(ptyId)
  const environment = useAppStore
    .getState()
    .runtimeEnvironments.find((entry) => entry.id === environmentId)
  const pairingRevision = environmentId ? getRuntimeEnvironmentRevision(environmentId) : undefined
  const runtimeId = environment?.runtimeId
  const requestId = createUuidV4()
  let started = false
  let cancelled = false
  const handle = enqueueNativeChatPtySend(
    ptyId,
    1,
    ({ markSubmitted, isCancelled }) => {
      void (async () => {
        // Why: the composer records its optimistic row immediately after enqueueing.
        await Promise.resolve()
        try {
          if (!environmentId || !terminal || !runtimeId || pairingRevision === undefined) {
            throw new Error('Reconnect to this server before sending.')
          }
          const binding: NativeChatReliableDelivery = {
            requestId,
            environmentId,
            runtimeId,
            pairingRevision,
            terminal,
            provider
          }
          const pendingId = callbacks.pendingId()
          if (pendingId) {
            callbacks.outcome?.beginReliable?.(pendingId, binding)
          }
          await assertRuntimeEnvironmentCapability(
            environmentId,
            TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY,
            'Update this server to send reliable Chat messages.'
          )
          await assertRuntimeEnvironmentCapability(
            environmentId,
            TERMINAL_PROMPT_CLEAR_INPUT_RUNTIME_CAPABILITY,
            'Update this server to send reliable Chat messages.'
          )
          if (cancelled || isCancelled()) {
            return
          }
          started = true
          const result = await callRuntimeRpc<unknown>(
            { kind: 'environment', environmentId },
            'terminal.send',
            {
              terminal,
              text,
              enter: true,
              agentPrompt: true,
              clearUnsubmittedInput: true,
              waitSubmitMs: 1000,
              client: { id: 'orca-desktop', type: 'desktop' }
            },
            {
              timeoutMs: 15_000,
              orchestrationRequestId: requestId,
              expectedEnvironmentPairingRevision: pairingRevision,
              expectedEnvironmentRuntimeId: runtimeId
            }
          )
          const receipt = readNativeChatReliableReceipt(result, binding)
          if (pendingId && receipt?.rejected) {
            callbacks.outcome?.reject(pendingId)
          } else if (pendingId && receipt && !receipt.rejected) {
            callbacks.outcome?.received?.(pendingId, receipt.binding)
          } else if (pendingId) {
            callbacks.outcome?.holdUnconfirmed(pendingId)
          }
        } catch (error) {
          const pendingId = callbacks.pendingId()
          if (pendingId) {
            if (started) {
              callbacks.outcome?.holdUnconfirmed(pendingId)
            } else {
              callbacks.outcome?.reject(pendingId)
            }
          }
          callbacks.onError(error instanceof Error ? error.message : String(error))
        } finally {
          markSubmitted()
        }
      })()
    },
    {
      canCancel: () => !started,
      onCancelled: () => {
        cancelled = true
        const pendingId = callbacks.pendingId()
        if (pendingId) {
          callbacks.outcome?.reject(pendingId)
        }
      }
    }
  )
  return {
    ...handle,
    cancel: () => {
      if (!started) {
        cancelled = true
        handle.cancel()
      }
    },
    retainPendingOnCancel: () => started || cancelled
  }
}
