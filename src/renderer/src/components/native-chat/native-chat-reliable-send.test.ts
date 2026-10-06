import { beforeEach, expect, it, vi } from 'vitest'
import {
  sendNativeChatReliableMessage,
  recoverNativeChatReliableDelivery,
  readNativeChatReliableReceipt,
  type NativeChatReliableDelivery
} from './native-chat-reliable-send'
import {
  cancelNativeChatPtySends,
  resetNativeChatPtySendQueuesForTests
} from './native-chat-pty-send-queue'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'

const mocks = vi.hoisted(() => ({ call: vi.fn(), capability: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.call,
  assertRuntimeEnvironmentCapability: mocks.capability
}))
vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ runtimeEnvironments: [{ id: 'env', runtimeId: 'owner' }] }) }
}))
const binding: NativeChatReliableDelivery = {
  requestId: 'request',
  environmentId: 'env',
  runtimeId: 'owner',
  pairingRevision: 42,
  terminal: 'terminal',
  provider: 'codex',
  processIncarnation: 'incarnation',
  generation: 5
}
function receipt(requestId = binding.requestId) {
  return {
    send: {
      handle: 'terminal',
      accepted: true,
      prompt: {
        requestId,
        stages: ['input_accepted'],
        provider: 'codex',
        observation: 'supported',
        processIncarnation: 'incarnation',
        generation: 5
      }
    }
  }
}
function callbacks() {
  return {
    pendingId: () => 'pending',
    onError: vi.fn(),
    outcome: {
      reject: vi.fn(),
      holdUnconfirmed: vi.fn(),
      beginReliable: vi.fn(),
      received: vi.fn()
    }
  }
}
beforeEach(() => {
  resetNativeChatPtySendQueuesForTests()
  mocks.call.mockReset()
  mocks.capability.mockReset().mockResolvedValue(undefined)
  replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 1, pairingRevision: 42 }])
})
it('sends one complete prompt with a UUID and pinned runtime even if cancelled after starting', async () => {
  let resolve!: (value: unknown) => void
  mocks.call.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const events = callbacks()
  const handle = sendNativeChatReliableMessage('remote:env@@terminal', 'one\ntwo', 'codex', events)
  await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
  handle.cancel()
  cancelNativeChatPtySends('remote:env@@terminal')
  expect(handle.retainPendingOnCancel?.()).toBe(true)
  const args = mocks.call.mock.calls[0]
  expect(args?.[2]).toMatchObject({
    text: 'one\ntwo',
    enter: true,
    clearUnsubmittedInput: true,
    agentPrompt: true
  })
  expect(args?.[3]).toMatchObject({
    expectedEnvironmentPairingRevision: 42,
    expectedEnvironmentRuntimeId: 'owner'
  })
  const requestId = args?.[3].orchestrationRequestId
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
  resolve(receipt(requestId))
  await handle.settled
  expect(events.outcome.received).toHaveBeenCalledOnce()
  expect(mocks.call).toHaveBeenCalledOnce()
})
it('lost acknowledgment never retries and receipt recovery only reads requestShow', async () => {
  mocks.call.mockRejectedValueOnce(new Error('connection lost'))
  const events = callbacks()
  const handle = sendNativeChatReliableMessage('remote:env@@terminal', 'retain me', 'codex', events)
  await handle.settled
  expect(events.outcome.holdUnconfirmed).toHaveBeenCalledWith('pending')
  expect(events.outcome.reject).not.toHaveBeenCalled()
  mocks.call.mockResolvedValueOnce({ requestId: 'request', state: 'absent' })
  expect(await recoverNativeChatReliableDelivery(binding)).toBeNull()
  expect(mocks.call.mock.calls.map((args) => args[1])).toEqual([
    'terminal.send',
    'orchestration.requestShow'
  ])
  expect(mocks.call.mock.calls[1]?.[3]).toMatchObject({
    expectedEnvironmentPairingRevision: 42,
    expectedEnvironmentRuntimeId: 'owner'
  })
})
it('refuses an old host before terminal input and preserves a rejected echo', async () => {
  mocks.capability.mockRejectedValueOnce(new Error('Update this server'))
  const events = callbacks()
  await sendNativeChatReliableMessage('remote:env@@terminal', 'keep me', 'codex', events).settled
  expect(mocks.call).not.toHaveBeenCalled()
  expect(events.outcome.reject).toHaveBeenCalledWith('pending')
})
it('cancels preflight without writing, including cancellation by a command', async () => {
  let release!: () => void
  mocks.capability.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        release = done
      })
  )
  const handle = sendNativeChatReliableMessage(
    'remote:env@@terminal',
    'cancel me',
    'codex',
    callbacks()
  )
  await vi.waitFor(() => expect(mocks.capability).toHaveBeenCalledOnce())
  cancelNativeChatPtySends('remote:env@@terminal')
  release()
  await handle.settled
  await Promise.resolve()
  expect(mocks.call).not.toHaveBeenCalled()
})
it('serializes two rapid messages through completion of the first RPC', async () => {
  let reject!: (error: Error) => void
  mocks.call
    .mockImplementationOnce(
      () =>
        new Promise((_done, fail) => {
          reject = fail
        })
    )
    .mockRejectedValue(new Error('lost'))
  const first = sendNativeChatReliableMessage('remote:env@@terminal', 'first', 'codex', callbacks())
  const second = sendNativeChatReliableMessage(
    'remote:env@@terminal',
    'second',
    'codex',
    callbacks()
  )
  await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
  reject(new Error('lost'))
  await Promise.all([first.settled, second.settled])
  expect(mocks.call.mock.calls.map((args) => args[2].text)).toEqual(['first', 'second'])
})
it.each(['requestId', 'provider', 'processIncarnation', 'generation', 'observation'] as const)(
  'does not approve a receipt with the wrong %s',
  (field) => {
    const wrong = receipt()
    const value = field === 'generation' ? 6 : 'wrong'
    expect(
      readNativeChatReliableReceipt(
        { send: { ...wrong.send, prompt: { ...wrong.send.prompt, [field]: value } } },
        binding
      )
    ).toBeNull()
  }
)

it('reports a missing runtime owner after the composer has recorded the echo', async () => {
  const events = callbacks()
  const handle = sendNativeChatReliableMessage(
    'remote:missing@@terminal',
    'retain me',
    'codex',
    events
  )
  await handle.settled
  expect(events.outcome.reject).toHaveBeenCalledWith('pending')
  expect(mocks.call).not.toHaveBeenCalled()
})
