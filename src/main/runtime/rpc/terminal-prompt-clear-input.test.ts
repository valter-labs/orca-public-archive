import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../../shared/tui-agent'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../shared/agent-tui-input-clear'
import {
  RUNTIME_CAPABILITIES,
  TERMINAL_PROMPT_CLEAR_INPUT_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { createAgentPromptSubmissionRuntime } from '../agent-prompt-submission-runtime-test-fixture'
import { OrchestrationDb } from '../orchestration/db'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { ORCHESTRATION_MUTATION_REQUEST_METHODS } from './methods/orchestration/runs/mutation-request-show'

vi.mock('../../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-clear',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-clear',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

function clearingRequest(
  terminal: string,
  requestId: string | undefined,
  text: string,
  overrides: Record<string, unknown> = {}
): RpcRequest {
  return {
    id: `rpc-${requestId ?? 'none'}`,
    authToken: 'token',
    method: 'terminal.send',
    ...(requestId ? { orchestrationRequestId: requestId } : {}),
    params: {
      terminal,
      text,
      enter: true,
      agentPrompt: true,
      clearUnsubmittedInput: true,
      client: { id: 'orca-desktop', type: 'desktop' },
      ...overrides
    }
  }
}

async function createHarness(agent: TuiAgent, busy = false) {
  const created = await createAgentPromptSubmissionRuntime(() => undefined, agent)
  created.runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'unused' }),
    write: (_ptyId, data) => {
      created.writes.push(data)
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => agent
  })
  const db = new OrchestrationDb(':memory:')
  created.runtime.setOrchestrationDb(db)
  if (busy) {
    created.runtime.onPtyData(
      'pty-prompt',
      `\x1b]9999;{"state":"working","agentType":"${agent}"}\x07`,
      Date.now()
    )
  }
  return {
    ...created,
    db,
    dispatcher: new RpcDispatcher({
      runtime: created.runtime,
      methods: [...TERMINAL_METHODS, ...ORCHESTRATION_MUTATION_REQUEST_METHODS]
    })
  }
}

async function dispatchSettled(
  harness: Awaited<ReturnType<typeof createHarness>>,
  request: RpcRequest
) {
  const pending = harness.dispatcher.dispatch(request)
  await vi.runAllTimersAsync()
  return await pending
}

describe('terminal.send clearUnsubmittedInput', () => {
  afterEach(() => vi.useRealTimers())

  it('is advertised so clients can refuse hosts that would strip it', () => {
    expect(RUNTIME_CAPABILITIES).toContain(TERMINAL_PROMPT_CLEAR_INPUT_RUNTIME_CAPABILITY)
  })

  it.each(['claude', 'codex'] as const)(
    'clears stale %s input once, then pastes the whole multiline prompt, then one Enter',
    async (agent) => {
      vi.useFakeTimers()
      const harness = await createHarness(agent, true)
      harness.runtime.onPtyData('pty-prompt', '› stale half-typed line', Date.now())

      const response = await dispatchSettled(
        harness,
        clearingRequest(harness.handle, `${agent}-clear`, 'line one\nline two')
      )

      expect(response).toMatchObject({
        ok: true,
        result: {
          send: { accepted: true, prompt: { requestId: `${agent}-clear` } },
          mutation: { replayed: false }
        }
      })
      expect(harness.writes).toHaveLength(3)
      expect(harness.writes[0]).toBe(AGENT_TUI_CLEAR_INPUT_MAX)
      expect(harness.writes[1]).toContain('line one\nline two')
      expect(harness.writes[1]).not.toContain('\u0015')
      expect(harness.writes[2]).toBe('\r')
      harness.db.close()
    }
  )

  it('replays the same request ID without clearing, pasting, or pressing Enter again', async () => {
    vi.useFakeTimers()
    const harness = await createHarness('codex', true)
    await dispatchSettled(harness, clearingRequest(harness.handle, 'same-id', 'only once'))
    const writesAfterFirst = [...harness.writes]

    const replacement = new RpcDispatcher({ runtime: harness.runtime, methods: TERMINAL_METHODS })
    const replay = replacement.dispatch(clearingRequest(harness.handle, 'same-id', 'only once'))
    await vi.runAllTimersAsync()

    await expect(replay).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: true }, mutation: { replayed: true } }
    })
    expect(harness.writes).toEqual(writesAfterFirst)
    harness.db.close()
  })

  it('refuses a target that is not a settled Claude/Codex prompt without touching it', async () => {
    vi.useFakeTimers()
    const harness = await createHarness('aider')

    const response = await dispatchSettled(
      harness,
      clearingRequest(harness.handle, 'refused-target', 'keep me')
    )

    expect(response).toMatchObject({
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0 } }
    })
    expect(harness.writes).toEqual([])
    // The refusal is durable: asking again with the same ID cannot turn it into a write.
    const replay = await dispatchSettled(
      harness,
      clearingRequest(harness.handle, 'refused-target', 'keep me')
    )
    expect(replay).toMatchObject({ ok: true, result: { send: { accepted: false } } })
    expect(harness.writes).toEqual([])
    harness.db.close()
  })

  it('rejects a clearing send without a durable request ID before any write', async () => {
    vi.useFakeTimers()
    const harness = await createHarness('codex', true)

    const response = await dispatchSettled(
      harness,
      clearingRequest(harness.handle, undefined, 'no receipt')
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(harness.writes).toEqual([])
    harness.db.close()
  })

  it.each([
    ['without Enter', { enter: false }],
    ['with interrupt', { interrupt: true }],
    ['from a mobile client', { client: { id: 'phone', type: 'mobile' } }],
    ['as a guarded two-phase send', { requireAgentStatus: 'sendable' }]
  ])('rejects a clearing send %s before any write', async (_label, overrides) => {
    vi.useFakeTimers()
    const harness = await createHarness('codex', true)

    const response = await dispatchSettled(
      harness,
      clearingRequest(harness.handle, 'bad-shape', 'bad shape', overrides)
    )

    expect(response).toMatchObject({ ok: false })
    expect(harness.writes).toEqual([])
    harness.db.close()
  })

  it('orders two rapid prompts so each clear runs only after the previous Enter', async () => {
    vi.useFakeTimers()
    const harness = await createHarness('codex', true)

    const first = harness.dispatcher.dispatch(clearingRequest(harness.handle, 'q-1', 'first'))
    const second = harness.dispatcher.dispatch(clearingRequest(harness.handle, 'q-2', 'second'))
    await vi.runAllTimersAsync()
    await Promise.all([first, second])

    expect(harness.writes).toHaveLength(6)
    expect(harness.writes[0]).toBe(AGENT_TUI_CLEAR_INPUT_MAX)
    expect(harness.writes[1]).toContain('first')
    expect(harness.writes[2]).toBe('\r')
    expect(harness.writes[3]).toBe(AGENT_TUI_CLEAR_INPUT_MAX)
    expect(harness.writes[4]).toContain('second')
    expect(harness.writes[5]).toBe('\r')
    harness.db.close()
  })

  it('completes paste and Enter after the request disconnects during the first write', async () => {
    vi.useFakeTimers()
    const harness = await createHarness('codex', true)
    const controller = new AbortController()
    harness.runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'unused' }),
      write: (_ptyId, data) => {
        harness.writes.push(data)
        controller.abort()
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const response = harness.dispatcher.dispatch(
      clearingRequest(harness.handle, 'disconnect-during-clear', 'complete me'),
      { signal: controller.signal }
    )
    await vi.runAllTimersAsync()
    await expect(response).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: true } }
    })
    expect(harness.writes).toHaveLength(3)
    expect(harness.writes[1]).toContain('complete me')
    expect(harness.writes[2]).toBe('\r')
    harness.db.close()
  })

  it('exposes the receipt to requestShow for the same caller', async () => {
    vi.useFakeTimers()
    const harness = await createHarness('codex', true)
    await dispatchSettled(harness, clearingRequest(harness.handle, 'show-me', 'receipted'))
    const writesAfterSend = [...harness.writes]

    const shown = await dispatchSettled(harness, {
      id: 'rpc-show',
      authToken: 'token',
      method: 'orchestration.requestShow',
      params: { request: 'show-me' }
    })

    expect(shown).toMatchObject({
      ok: true,
      result: {
        state: 'completed',
        receipt: { send: { accepted: true, prompt: { requestId: 'show-me' } } }
      }
    })
    expect(harness.writes).toEqual(writesAfterSend)
    harness.db.close()
  })
  it('does not repeat a completed prompt on the WebSocket unary dispatch route', async () => {
    vi.useFakeTimers()
    const harness = await createHarness('codex', true)
    const request = clearingRequest(harness.handle, 'websocket-replay', 'send once')
    const reply = vi.fn()
    const first = harness.dispatcher.dispatchStreaming(request, reply)
    await vi.runAllTimersAsync()
    await first
    const writes = [...harness.writes]
    const replay = harness.dispatcher.dispatchStreaming(request, reply)
    await vi.runAllTimersAsync()
    await replay
    expect(JSON.parse(reply.mock.calls.at(-1)![0])).toMatchObject({
      ok: true,
      result: { mutation: { replayed: true } }
    })
    expect(harness.writes).toEqual(writes)
    harness.db.close()
  })

  it('retains uncertainty after body delivery fails before Enter on the WebSocket route', async () => {
    vi.useFakeTimers()
    const harness = await createHarness('codex', true)
    harness.runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'unused' }),
      write: (_ptyId, data) => {
        harness.writes.push(data)
        return data !== '\r'
      },
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const request = clearingRequest(harness.handle, 'websocket-partial', 'body may have landed')
    const reply = vi.fn()
    const first = harness.dispatcher.dispatchStreaming(request, reply)
    await vi.runAllTimersAsync()
    await first
    expect(JSON.parse(reply.mock.calls.at(-1)![0])).toMatchObject({ ok: false })
    expect(harness.writes[1]).toContain('body may have landed')
    const writes = [...harness.writes]
    await harness.dispatcher.dispatchStreaming(
      {
        id: 'receipt-read',
        authToken: 'token',
        method: 'orchestration.requestShow',
        params: { request: 'websocket-partial' }
      },
      reply
    )
    expect(JSON.parse(reply.mock.calls.at(-1)![0])).toMatchObject({
      ok: true,
      result: { state: 'pending' }
    })
    await harness.dispatcher.dispatchStreaming(request, reply)
    expect(JSON.parse(reply.mock.calls.at(-1)![0])).toMatchObject({
      ok: false,
      error: { code: 'operation_unknown' }
    })
    expect(harness.writes).toEqual(writes)
    harness.db.close()
  })
})
