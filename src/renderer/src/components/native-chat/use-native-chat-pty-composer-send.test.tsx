// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatSendClassification } from '../../../../shared/native-chat-slash-commands'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import { sendNativeChatMessage } from './native-chat-runtime-send'
import { appendPendingSendCache, clearPendingSendCacheForTests } from './native-chat-pending'
import { sendNativeChatMessageWithImageAttachments } from './native-chat-runtime-image-send'

const handle = vi.hoisted(() => ({ cancel: () => {}, settleAfterMs: 0 }))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(() => handle),
  sendNativeChatTypedCommand: vi.fn(() => handle),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: vi.fn(() => handle)
}))
vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ clearNativeChatLaunchDraft: vi.fn() }) }
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))

function send(
  agent: AgentType,
  classification: NativeChatSendClassification,
  draft: string,
  imagePaths: string[] = [],
  ptyId = 'pty'
) {
  const callbacks = {
    rejected: vi.fn(),
    unconfirmed: vi.fn(),
    setDraft: vi.fn(),
    setNotice: vi.fn()
  }
  const { result } = renderHook(() =>
    useNativeChatPtyComposerSend({
      agent,
      draft,
      imageAttachments: imagePaths.map((path) => ({ path })),
      disabled: false,
      isDispatchingSessionOption: false,
      launchDraftResolved: true,
      resolveTarget: () => ({ ptyId, settings: null }),
      classifySend: () => classification,
      onOptimisticSend: () => 'pending-1',
      optimisticSendOutcome: { reject: callbacks.rejected, holdUnconfirmed: callbacks.unconfirmed },
      sessionOptionsSurface: null,
      terminalTabId: 'tab',
      trackPendingSend: vi.fn(),
      setHistory: vi.fn(),
      setDraft: callbacks.setDraft,
      setCaret: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments: vi.fn(),
      setNotice: callbacks.setNotice
    })
  )
  result.current()
  return callbacks
}

beforeEach(() => {
  vi.mocked(sendNativeChatMessage).mockClear()
  vi.mocked(sendNativeChatMessageWithImageAttachments).mockClear()
})

it('routes a Claude chat send outcome to its own pending echo', () => {
  const callbacks = send('claude', 'chat', 'hello')
  const options = vi.mocked(sendNativeChatMessage).mock.calls[0]?.[3]
  options?.onWriteRejected?.()
  options?.onWriteUnconfirmed?.()
  expect(callbacks.rejected).toHaveBeenCalledWith('pending-1')
  expect(callbacks.unconfirmed).toHaveBeenCalledWith('pending-1')
  expect(options?.frameBody).toBe(true)
})

it('routes a Claude image send outcome to its own pending echo', () => {
  const callbacks = send('claude', 'chat', 'look', ['/tmp/shot.png'])
  vi.mocked(sendNativeChatMessageWithImageAttachments).mock.calls[0]?.[5]?.onWriteRejected?.()
  expect(callbacks.rejected).toHaveBeenCalledWith('pending-1')
})

it.each([
  ['codex', 'chat', 'hello'],
  ['claude', 'command', '/compact']
] as const)('leaves a %s %s send on the unobserved write path', (agent, classification, draft) => {
  send(agent, classification, draft)
  expect(vi.mocked(sendNativeChatMessage).mock.calls[0]?.[3]?.onWriteRejected).toBeUndefined()
  // Slash commands and Codex keep raw single-line bytes; only Claude chat bodies are framed.
  expect(vi.mocked(sendNativeChatMessage).mock.calls[0]?.[3]?.frameBody).toBeUndefined()
})

it('refuses a ninth pending remote prompt before writes or draft clearing', () => {
  clearPendingSendCacheForTests()
  for (let index = 0; index < 8; index += 1) {
    appendPendingSendCache(
      { paneKey: 'tab', agent: 'codex' },
      {
        id: `pending-${index}`,
        text: `uncertain-${index}`,
        sentAt: index,
        delivery: 'unconfirmed',
        reliableDelivery: {
          requestId: `request-${index}`,
          environmentId: 'env',
          runtimeId: 'owner',
          pairingRevision: 42,
          terminal: 'terminal',
          provider: 'codex'
        }
      }
    )
  }
  const events = send('codex', 'chat', 'keep this draft', [], 'remote:env@@terminal')
  expect(events.setDraft).not.toHaveBeenCalled()
  expect(sendNativeChatMessage).not.toHaveBeenCalled()
  expect(events.setNotice).toHaveBeenCalledWith(
    'Resolve or dismiss pending messages before sending more.'
  )
  clearPendingSendCacheForTests()
})
