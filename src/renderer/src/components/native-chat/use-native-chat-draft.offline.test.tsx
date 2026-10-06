// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useNativeChatDraft } from './use-native-chat-draft'
import { clearNativeChatDraftCacheForTests } from './native-chat-draft-cache'

it('edits and remounts an offline multiline draft without terminal or runtime writes', () => {
  clearNativeChatDraftCacheForTests()
  const rpc = vi.fn()
  const write = vi.fn()
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: rpc }, pty: { write } } })
  const first = renderHook(() => useNativeChatDraft('offline-pane', () => false))
  act(() => first.result.current.setDraft('first line\nsecond line'))
  expect(first.result.current.draft).toBe('first line\nsecond line')
  first.unmount()
  const second = renderHook(() => useNativeChatDraft('offline-pane', () => false))
  expect(second.result.current.draft).toBe('first line\nsecond line')
  expect(rpc).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
  second.unmount()
  vi.unstubAllGlobals()
  clearNativeChatDraftCacheForTests()
})
