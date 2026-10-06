// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeEnvironmentStatus,
  RuntimeHostStatusSnapshot
} from '../../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { setDriverForPty } from '@/lib/pane-manager/mobile-driver-state'

vi.mock('../../store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create<{ runtimeStatusByEnvironmentId: Map<string, RuntimeEnvironmentStatus> }>(
      () => ({ runtimeStatusByEnvironmentId: new Map() })
    )
  }
})
import { useAppStore } from '../../store'
import { useNativeChatCanSend } from './use-native-chat-can-send'

const status: RuntimeStatus = {
  runtimeId: 'runtime-a',
  rendererGraphEpoch: 1,
  graphStatus: 'ready',
  authoritativeWindowId: 1,
  liveTabCount: 1,
  liveLeafCount: 1
}
const ptyId = toRemoteRuntimePtyId('terminal:1', 'env-a')
function publish(
  verification: RuntimeHostStatusSnapshot['verification'],
  transport: RuntimeHostStatusSnapshot['transport']
) {
  act(() =>
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [
          'env-a',
          {
            status,
            checkedAt: 1,
            snapshot: {
              environmentId: 'env-a',
              pairingRevision: 1,
              sequence: 1,
              checkedAt: 1,
              status,
              verification,
              transport
            }
          }
        ]
      ])
    })
  )
}
beforeEach(() => {
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  setDriverForPty(ptyId, { kind: 'idle' })
})
afterEach(() => {
  cleanup()
  setDriverForPty(ptyId, { kind: 'idle' })
})

describe('paired native Chat send availability', () => {
  it.each(['claude', 'codex'])(
    'blocks %s while disconnected or reconnecting and resumes only after a verified ready connection',
    (agent) => {
      publish('verified', 'ready')
      const { result } = renderHook(() => useNativeChatCanSend(ptyId, agent))
      expect(result.current).toBe(true)
      publish('unavailable', 'disconnected')
      expect(result.current).toBe(false)
      publish('checking', 'connecting')
      expect(result.current).toBe(false)
      publish('unavailable', 'ready')
      expect(result.current).toBe(false)
      publish('verified', 'connecting')
      expect(result.current).toBe(false)
      publish('verified', 'ready')
      expect(result.current).toBe(true)
      act(() => setDriverForPty(ptyId, { kind: 'mobile', clientId: 'phone' }))
      expect(result.current).toBe(false)
      act(() => setDriverForPty(ptyId, { kind: 'idle' }))
      expect(result.current).toBe(true)
    }
  )
  it('does not infer availability for one paired owner from the active or another owner', () => {
    publish('verified', 'ready')
    const otherPty = toRemoteRuntimePtyId('terminal:1', 'env-b')
    const { result } = renderHook(() => useNativeChatCanSend(otherPty, 'codex'))
    expect(result.current).toBe(false)
  })
  it('blocks while the control socket reconnects even before the verified snapshot is replaced', () => {
    publish('verified', 'ready')
    const { result } = renderHook(() => useNativeChatCanSend(ptyId, 'codex'))
    expect(result.current).toBe(true)
    act(() =>
      useAppStore.setState((state) => {
        const entry = state.runtimeStatusByEnvironmentId.get('env-a')!
        return {
          runtimeStatusByEnvironmentId: new Map([
            [
              'env-a',
              {
                ...entry,
                remoteControl: {
                  state: 'reconnecting',
                  pendingRequestCount: 0,
                  subscriptionCount: 0,
                  reconnectAttempt: 1,
                  lastConnectedAt: null,
                  lastClose: null,
                  lastError: null
                }
              }
            ]
          ])
        }
      })
    )
    expect(result.current).toBe(false)
    publish('verified', 'ready')
    expect(result.current).toBe(true)
  })
  it.each(['local-pty', 'ssh:pty'])('keeps existing %s presence-lock eligibility', (localPty) => {
    const { result } = renderHook(() => useNativeChatCanSend(localPty, 'codex'))
    expect(result.current).toBe(true)
    publish('unavailable', 'disconnected')
    expect(result.current).toBe(true)
  })
})
