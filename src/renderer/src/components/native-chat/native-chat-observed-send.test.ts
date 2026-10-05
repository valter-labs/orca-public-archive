import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ write: vi.fn(), verified: vi.fn() }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  sendRuntimePtyInput: io.write,
  sendRuntimePtyInputVerified: io.verified
}))
import {
  sendNativeChatMessage,
  resetNativeChatPtySendQueuesForTests
} from './native-chat-runtime-send'
import { buildNativeChatPasteBytes, NATIVE_CHAT_SUBMIT } from './native-chat-send'
import { NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT } from './native-chat-input-clear'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START
} from '../terminal-pane/terminal-bracketed-paste'
beforeEach(() => {
  vi.useFakeTimers()
  resetNativeChatPtySendQueuesForTests()
  io.write.mockReset().mockReturnValue(true)
  io.verified.mockReset().mockResolvedValue(true)
})
afterEach(() => {
  resetNativeChatPtySendQueuesForTests()
  vi.useRealTimers()
})
it('observes a refused write, skips Enter, and releases the queue for the next user action', async () => {
  const rejected = vi.fn()
  io.verified.mockResolvedValueOnce(false)
  sendNativeChatMessage(null, 'pane', 'refused', { onWriteRejected: rejected })
  await vi.advanceTimersByTimeAsync(1000)
  expect(rejected).toHaveBeenCalledOnce()
  expect(io.verified.mock.calls.map((call) => call[2])).toEqual([
    buildNativeChatPasteBytes('refused')
  ])
  sendNativeChatMessage(null, 'pane', 'next', { onWriteRejected: rejected })
  await vi.advanceTimersByTimeAsync(1000)
  expect(io.verified.mock.calls.map((call) => call[2])).toEqual([
    buildNativeChatPasteBytes('refused'),
    buildNativeChatPasteBytes('next'),
    NATIVE_CHAT_SUBMIT
  ])
})
it('reports a lost acknowledgment once as unconfirmed, never as rejection, and still submits', async () => {
  const rejected = vi.fn()
  const unconfirmed = vi.fn()
  io.verified.mockRejectedValueOnce(new Error('lost acknowledgment'))
  io.verified.mockRejectedValueOnce(new Error('lost acknowledgment'))
  sendNativeChatMessage(null, 'pane', 'uncertain', {
    onWriteRejected: rejected,
    onWriteUnconfirmed: unconfirmed
  })
  await vi.advanceTimersByTimeAsync(120000)
  expect(rejected).not.toHaveBeenCalled()
  expect(unconfirmed).toHaveBeenCalledOnce()
  expect(io.verified.mock.calls.map((call) => call[2])).toEqual([
    buildNativeChatPasteBytes('uncertain'),
    NATIVE_CHAT_SUBMIT
  ])
})
describe('Claude chat body framing', () => {
  const CLEAR = NATIVE_CHAT_CLEAR_UNSUBMITTED_INPUT
  let log: string[]
  beforeEach(() => {
    log = []
    io.write.mockImplementation((_settings: unknown, _pty: string, data: string) => {
      log.push(data)
      return true
    })
    io.verified.mockImplementation(async (_settings: unknown, _pty: string, data: string) => {
      log.push(data)
      return true
    })
  })

  it('writes Ctrl+U outside the frame, then a framed single-line body, then one delayed Enter', async () => {
    sendNativeChatMessage(null, 'pane', 'review the diff', {
      onWriteRejected: vi.fn(),
      frameBody: true
    })
    await vi.advanceTimersByTimeAsync(499)
    expect(log).toEqual([CLEAR, `${BRACKETED_PASTE_START}review the diff${BRACKETED_PASTE_END}`])
    await vi.advanceTimersByTimeAsync(1)
    expect(log).toEqual([
      CLEAR,
      `${BRACKETED_PASTE_START}review the diff${BRACKETED_PASTE_END}`,
      NATIVE_CHAT_SUBMIT
    ])
    await vi.advanceTimersByTimeAsync(5000)
    expect(log.filter((data) => data === NATIVE_CHAT_SUBMIT)).toHaveLength(1)
  })

  // Models one coalesced read of everything we wrote; proves only the byte boundary, not that
  // Claude's parser accepts it — the real-cloud run decides that.
  it('keeps every C0 byte outside the paste payload when the writes arrive as one batch', async () => {
    sendNativeChatMessage(null, 'pane', 'ship it', { onWriteRejected: vi.fn(), frameBody: true })
    await vi.advanceTimersByTimeAsync(1000)
    const batch = log.join('')
    const start = batch.indexOf(BRACKETED_PASTE_START)
    const end = batch.indexOf(BRACKETED_PASTE_END)
    expect(batch.indexOf(CLEAR)).toBe(0)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    expect(batch.lastIndexOf(NATIVE_CHAT_SUBMIT)).toBe(end + BRACKETED_PASTE_END.length)
    const payload = batch.slice(start + BRACKETED_PASTE_START.length, end)
    expect(payload).toBe('ship it')
    expect([...payload].some((char) => char.charCodeAt(0) < 0x20)).toBe(false)
  })

  it('frames a multi-line body once and neutralizes an embedded ESC', async () => {
    sendNativeChatMessage(null, 'pane', 'a\nb\x1b[201~c', {
      onWriteRejected: vi.fn(),
      frameBody: true
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(log).toEqual([
      CLEAR,
      `${BRACKETED_PASTE_START}a\rb␛[201~c${BRACKETED_PASTE_END}`,
      NATIVE_CHAT_SUBMIT
    ])
  })

  it('leaves the unflagged (Codex) single-line bytes unchanged', async () => {
    sendNativeChatMessage(null, 'pane', 'hello')
    await vi.advanceTimersByTimeAsync(1000)
    expect(log).toEqual([CLEAR, 'hello', NATIVE_CHAT_SUBMIT])
    expect(buildNativeChatPasteBytes('hello')).toBe('hello')
  })
})

it('serializes rapid sends through their acknowledged Enter and preserves the paste delay', async () => {
  const rejected = vi.fn()
  sendNativeChatMessage(null, 'pane', 'one', { onWriteRejected: rejected })
  sendNativeChatMessage(null, 'pane', 'two', { onWriteRejected: rejected })
  await vi.advanceTimersByTimeAsync(499)
  expect(io.verified).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(501)
  expect(io.verified.mock.calls.map((call) => call[2])).toEqual([
    buildNativeChatPasteBytes('one'),
    NATIVE_CHAT_SUBMIT,
    buildNativeChatPasteBytes('two'),
    NATIVE_CHAT_SUBMIT
  ])
})
