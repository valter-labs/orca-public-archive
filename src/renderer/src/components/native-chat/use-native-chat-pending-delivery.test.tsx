// @vitest-environment happy-dom
import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS,
  useNativeChatPendingDelivery
} from './use-native-chat-pending-delivery'
import { recoverNativeChatReliableDelivery } from './native-chat-reliable-send'
vi.mock('./native-chat-reliable-send', () => ({ recoverNativeChatReliableDelivery: vi.fn() }))
import { clearPendingSendCacheForTests } from './native-chat-pending'

const boundary: NativeChatMessage = {
  id: 'boundary',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'before' }],
  timestamp: null,
  source: 'transcript'
}
const args = { paneKey: 'pane', agent: 'claude' as const, messages: [boundary] }
function userRow(text: string): NativeChatMessage {
  return { ...boundary, id: `user:${text}`, role: 'user', blocks: [{ type: 'text', text }] }
}
function render() {
  return renderHook(({ messages }) => useNativeChatPendingDelivery({ ...args, messages }), {
    initialProps: { messages: [boundary] }
  })
}
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  clearPendingSendCacheForTests()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('terminal Chat pending delivery', () => {
  it('never flags an ordinary send, such as one Claude queues mid-turn', async () => {
    const { result } = render()
    act(() => result.current.record('queued follow up'))
    await tick(10 * 60_000)
    expect(result.current.notices.size).toBe(0)
    expect(result.current.pending[0]?.delivery).toBeUndefined()
  })
  it('marks a refused write as not sent, keeps its text, and dismisses it', () => {
    const { result } = render()
    act(() => {
      result.current.reject(result.current.record('refused'))
    })
    expect(result.current.pending[0]?.text).toBe('refused')
    expect([...result.current.notices.values()][0]?.text).toBe('Message not sent')
    act(() => [...result.current.notices.values()][0]?.onDismiss?.())
    expect(result.current.pending).toEqual([])
  })
  it('reports a lost acknowledgment as unconfirmed only after the hold passes with no row', async () => {
    const { result } = render()
    act(() => {
      result.current.holdUnconfirmed(result.current.record('lost ack'))
    })
    await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS - 1)
    expect(result.current.notices.size).toBe(0)
    await tick(1)
    expect([...result.current.notices.values()][0]?.text).toMatch(/Delivery unconfirmed/)
    expect(result.current.pending[0]?.text).toBe('lost ack')
  })
  it('clears a held send whose echo lands, before or after the hold ends', async () => {
    const { result, rerender } = render()
    act(() => {
      result.current.holdUnconfirmed(result.current.record('early'))
      result.current.holdUnconfirmed(result.current.record('late'))
    })
    rerender({ messages: [boundary, userRow('early')] })
    await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS)
    expect(result.current.pending.map((entry) => [entry.text, entry.delivery])).toEqual([
      ['early', undefined],
      ['late', 'unconfirmed']
    ])
    rerender({
      messages: [boundary, userRow('early'), userRow('late'), { ...boundary, id: 'answer' }]
    })
    expect(result.current.pending).toEqual([])
  })
  it.each(['rejected', 'unconfirmed'] as const)(
    'retires a resend of a %s message once its row lands',
    async (outcome) => {
      const { result, rerender } = render()
      act(() => {
        const id = result.current.record('try again')
        if (outcome === 'rejected') {
          result.current.reject(id)
        } else {
          result.current.holdUnconfirmed(id)
        }
      })
      await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS)
      expect(result.current.pending[0]?.delivery).toBe(outcome)
      act(() => result.current.record('try again'))
      expect(result.current.pending.map((entry) => entry.delivery)).toEqual([undefined])
      rerender({ messages: [boundary, userRow('try again'), { ...boundary, id: 'answer' }] })
      expect(result.current.pending).toEqual([])
    }
  )
  it('keeps a failed send through Stop while dropping sends Stop may have cancelled', () => {
    const { result } = render()
    act(() => {
      result.current.reject(result.current.record('refused'))
      result.current.record('in flight')
    })
    act(() => result.current.clear())
    expect(result.current.pending.map((entry) => [entry.text, entry.delivery])).toEqual([
      ['refused', 'rejected']
    ])
  })
  it('keeps the hold deadline across a remount', async () => {
    const first = render()
    act(() => {
      first.result.current.holdUnconfirmed(first.result.current.record('remounted'))
    })
    await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS / 2)
    first.unmount()
    const next = render()
    await tick(NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS / 2)
    expect(next.result.current.pending[0]?.delivery).toBe('unconfirmed')
  })
  it('keeps pending and notices referentially stable across stream updates', () => {
    const { result, rerender } = render()
    act(() => result.current.record('stable'))
    const { pending, notices } = result.current
    rerender({ messages: [boundary, { ...boundary, id: 'streamed' }] })
    expect(result.current.pending).toBe(pending)
    expect(result.current.notices).toBe(notices)
  })
})

it('retains uncertainty immediately and on remount, then recovers only the original receipt', async () => {
  const binding = {
    requestId: 'same-request',
    environmentId: 'env',
    runtimeId: 'owner',
    pairingRevision: 42,
    terminal: 'terminal',
    provider: 'claude' as const
  }
  vi.mocked(recoverNativeChatReliableDelivery).mockResolvedValue(null)
  const first = render()
  let id = ''
  act(() => {
    id = first.result.current.record('only copy')
    first.result.current.beginReliable(id, binding)
    first.result.current.holdUnconfirmed(id)
    first.result.current.clear()
  })
  expect(first.result.current.pending[0]?.delivery).toBe('unconfirmed')
  expect([...first.result.current.notices.values()][0]?.text).toMatch(/Delivery unconfirmed/)
  first.unmount()
  const second = render()
  await act(async () => {
    await Promise.resolve()
  })
  expect(recoverNativeChatReliableDelivery).toHaveBeenCalledWith(binding)
  expect(second.result.current.pending[0]?.text).toBe('only copy')
  expect(second.result.current.pending[0]?.delivery).toBe('unconfirmed')
  act(() =>
    second.result.current.received(id, {
      ...binding,
      processIncarnation: 'incarnation',
      generation: 5
    })
  )
  expect([...second.result.current.notices.values()][0]?.text).toBe(
    'Received by server — waiting for the conversation'
  )
  expect(second.result.current.pending).toHaveLength(1)
  second.rerender({ messages: [boundary, userRow('only copy'), { ...boundary, id: 'answer' }] })
  expect(second.result.current.pending).toEqual([])
})

it('updates a remounted pane when the original send loses its acknowledgment later', () => {
  const first = render()
  let id = ''
  act(() => {
    id = first.result.current.record('late lost ack')
    first.result.current.beginReliable(id, {
      requestId: 'late',
      environmentId: 'env',
      runtimeId: 'owner',
      pairingRevision: 42,
      terminal: 'terminal',
      provider: 'claude'
    })
  })
  const originalOutcome = first.result.current.holdUnconfirmed
  first.unmount()
  const second = render()
  act(() => originalOutcome(id))
  expect(second.result.current.pending[0]?.delivery).toBe('unconfirmed')
  expect([...second.result.current.notices.values()][0]?.text).toMatch(/Delivery unconfirmed/)
})
