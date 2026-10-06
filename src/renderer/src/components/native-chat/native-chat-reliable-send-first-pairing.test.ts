import { beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { sendNativeChatReliableMessage } from './native-chat-reliable-send'
import { resetNativeChatPtySendQueuesForTests } from './native-chat-pty-send-queue'

const mocks = vi.hoisted(() => {
  const state: {
    runtimeEnvironments: { id: string; runtimeId: string | null }[]
    runtimeStatusByEnvironmentId: Map<string, { snapshot: RuntimeHostStatusSnapshot }>
  } = {
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map()
  }
  return { call: vi.fn(), capability: vi.fn(), state }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.call,
  assertRuntimeEnvironmentCapability: mocks.capability
}))
vi.mock('../../store', () => ({ useAppStore: { getState: () => mocks.state } }))

function verifiedSnapshot(): RuntimeHostStatusSnapshot {
  return {
    environmentId: 'env',
    pairingRevision: 42,
    sequence: 1,
    checkedAt: 1,
    verification: 'verified',
    transport: 'ready',
    status: {
      runtimeId: 'owner',
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 1,
      liveLeafCount: 1
    }
  }
}

function callbacks() {
  return {
    pendingId: () => 'pending',
    onError: vi.fn(),
    outcome: { reject: vi.fn(), holdUnconfirmed: vi.fn(), beginReliable: vi.fn() }
  }
}

beforeEach(() => {
  resetNativeChatPtySendQueuesForTests()
  mocks.call.mockReset().mockResolvedValue({ send: { handle: 'terminal', accepted: false } })
  mocks.capability.mockReset().mockResolvedValue(undefined)
  mocks.state.runtimeEnvironments = [{ id: 'env', runtimeId: null }]
  mocks.state.runtimeStatusByEnvironmentId = new Map([['env', { snapshot: verifiedSnapshot() }]])
  replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 1, pairingRevision: 42 }])
})

it('sends after the first verified pairing before the saved catalog identity is relisted', async () => {
  const events = callbacks()
  await sendNativeChatReliableMessage('remote:env@@terminal', 'first Chat', 'codex', events).settled
  expect(mocks.call).toHaveBeenCalledOnce()
  expect(mocks.call.mock.calls[0]?.[3]).toMatchObject({
    expectedEnvironmentRuntimeId: 'owner',
    expectedEnvironmentPairingRevision: 42
  })
  expect(events.outcome.beginReliable).toHaveBeenCalledWith(
    'pending',
    expect.objectContaining({ runtimeId: 'owner', pairingRevision: 42 })
  )
  expect(events.onError).not.toHaveBeenCalled()
})

it.each([
  { environmentId: 'other' },
  { pairingRevision: 41 },
  { verification: 'checking' as const },
  { verification: 'unavailable' as const },
  { verification: 'blocked' as const },
  { transport: 'connecting' as const },
  { transport: 'disconnected' as const },
  { retired: true as const },
  { status: null }
])('rejects unverified or differently owned first-pairing evidence %j', async (change) => {
  mocks.state.runtimeStatusByEnvironmentId.set('env', {
    snapshot: { ...verifiedSnapshot(), ...change }
  })
  const events = callbacks()
  await sendNativeChatReliableMessage('remote:env@@terminal', 'keep me', 'codex', events).settled
  expect(mocks.call).not.toHaveBeenCalled()
  expect(mocks.capability).not.toHaveBeenCalled()
  expect(events.outcome.reject).toHaveBeenCalledWith('pending')
  expect(events.outcome.beginReliable).not.toHaveBeenCalled()
})

it('does not resurrect a removed pairing from its retained snapshot', async () => {
  mocks.state.runtimeEnvironments = []
  const events = callbacks()
  await sendNativeChatReliableMessage('remote:env@@terminal', 'keep me', 'codex', events).settled
  expect(mocks.call).not.toHaveBeenCalled()
  expect(events.outcome.reject).toHaveBeenCalledWith('pending')
})

it('keeps a known catalog owner instead of adopting a different snapshot identity', async () => {
  mocks.state.runtimeEnvironments = [{ id: 'env', runtimeId: 'catalog-owner' }]
  await sendNativeChatReliableMessage('remote:env@@terminal', 'keep owner', 'codex', callbacks())
    .settled
  expect(mocks.call.mock.calls[0]?.[3]).toMatchObject({
    expectedEnvironmentRuntimeId: 'catalog-owner'
  })
})

it('pins first-pairing identity and revision before capability awaits', async () => {
  let release!: () => void
  mocks.capability.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const handle = sendNativeChatReliableMessage(
    'remote:env@@terminal',
    'original owner',
    'codex',
    callbacks()
  )
  await vi.waitFor(() => expect(mocks.capability).toHaveBeenCalledOnce())
  mocks.state.runtimeStatusByEnvironmentId.clear()
  mocks.state.runtimeEnvironments = [{ id: 'env', runtimeId: 'replacement' }]
  replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 1, pairingRevision: 43 }])
  release()
  await handle.settled
  expect(mocks.call.mock.calls[0]?.[3]).toMatchObject({
    expectedEnvironmentRuntimeId: 'owner',
    expectedEnvironmentPairingRevision: 42
  })
})
