import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START
} from '../../../shared/agent-prompt-injection'
import { AGENT_TUI_COMMAND_KEY_INTERVAL_MS } from '../../../shared/agent-tui-command-typing'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../shared/agent-tui-input-clear'
import { createAgentPromptSubmissionRuntime } from '../agent-prompt-submission-runtime-test-fixture'
import { OrchestrationDb } from '../orchestration/db'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { ORCHESTRATION_MUTATION_REQUEST_METHODS } from './methods/orchestration/runs/mutation-request-show'

vi.mock('../../git/worktree', () => {
  const rows = [
    { path: '/tmp/worktree-a', head: 'abc', branch: 'clear', isBare: false, isMainWorktree: false }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(rows),
    listWorktreesStrict: vi.fn().mockResolvedValue(rows)
  }
})

function sendRequest(terminal: string, requestId: string): RpcRequest {
  return {
    id: `rpc-${requestId}`,
    authToken: 'token',
    method: 'terminal.send',
    orchestrationRequestId: requestId,
    params: {
      terminal,
      text: 'new prompt\nsecond line',
      enter: true,
      agentPrompt: true,
      clearUnsubmittedInput: true,
      waitSubmitMs: 1_000,
      client: { id: 'orca-desktop', type: 'desktop' }
    }
  }
}

async function createHarness(cursorPosition = 0) {
  const created = await createAgentPromptSubmissionRuntime(() => undefined, 'claude')
  const db = new OrchestrationDb(':memory:')
  created.runtime.setOrchestrationDb(db)
  let draft = Array.from({ length: 40 }, (_, index) => `stale ${index}`).join('\n')
  let cursor = Math.floor(draft.length * cursorPosition)
  let foreground = 'claude'
  let pastedControls = false
  let clearCount = 0
  let afterWrite = (_data: string): void => undefined
  const keyTimes: number[] = []
  const submitted: string[] = []
  const confirmForegroundProcess = vi.fn(async () => foreground)
  created.runtime.synchronizePtyOutputSequenceFromProvider(
    'pty-prompt',
    { value: 0, generation: 'continued' },
    0
  )
  created.runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'unused' }),
    kill: () => true,
    getForegroundProcess: async () => foreground,
    confirmForegroundProcess,
    write: (_ptyId, data) => {
      created.writes.push(data)
      // Why: the captured Claude failure accepts CR but not a turn after a batched clear.
      if ([...data].every((key) => key === '\x15' || key === '\x0b')) {
        pastedControls ||= data.length !== 1
        keyTimes.push(Date.now())
        clearCount += data.length
        if (data === '\x15' && cursor > 0) {
          const start = draft.lastIndexOf('\n', cursor - 1) + 1
          const from = start === cursor ? cursor - 1 : start
          draft = draft.slice(0, from) + draft.slice(cursor)
          cursor = from
        } else if (data === '\x0b' && cursor < draft.length) {
          const newline = draft.indexOf('\n', cursor)
          const end = newline === cursor ? cursor + 1 : newline === -1 ? draft.length : newline
          draft = draft.slice(0, cursor) + draft.slice(end)
        }
      } else if (data.startsWith(AGENT_PROMPT_BRACKETED_PASTE_START)) {
        const body = data.slice(
          AGENT_PROMPT_BRACKETED_PASTE_START.length,
          -AGENT_PROMPT_BRACKETED_PASTE_END.length
        )
        draft = draft.slice(0, cursor) + body + draft.slice(cursor)
        cursor += body.length
        created.runtime.onPtyData('pty-prompt', '\x1b[?25h', Date.now())
      } else if (
        data === '\r' &&
        !pastedControls &&
        clearCount === AGENT_TUI_CLEAR_INPUT_MAX.length &&
        draft === 'new prompt\nsecond line'
      ) {
        submitted.push(draft)
        created.runtime.onPtyData(
          'pty-prompt',
          '\x1b]9999;{"state":"working","agentType":"claude"}\x07',
          Date.now()
        )
      }
      afterWrite(data)
      return true
    }
  })
  return {
    ...created,
    db,
    keyTimes,
    submitted,
    confirmForegroundProcess,
    setForeground: (value: string) => {
      foreground = value
    },
    afterWrite: (callback: (data: string) => void) => {
      afterWrite = callback
    },
    dispatcher: new RpcDispatcher({
      runtime: created.runtime,
      methods: [...TERMINAL_METHODS, ...ORCHESTRATION_MUTATION_REQUEST_METHODS]
    })
  }
}

describe('Claude clear keystroke cadence', () => {
  afterEach(() => vi.useRealTimers())

  it.each([0, 0.5, 1])(
    'clears forty stale lines from cursor fraction %s before one framed prompt and turn',
    async (cursor) => {
      vi.useFakeTimers()
      const harness = await createHarness(cursor)
      const request = sendRequest(harness.handle, `cursor-${cursor}`)
      const pending = harness.dispatcher.dispatch(request)
      await vi.runAllTimersAsync()
      await expect(pending).resolves.toMatchObject({
        ok: true,
        result: { send: { prompt: { stages: ['input_accepted', 'turn_started'] } } }
      })
      expect(harness.writes.slice(0, AGENT_TUI_CLEAR_INPUT_MAX.length)).toEqual([
        ...AGENT_TUI_CLEAR_INPUT_MAX
      ])
      expect(
        harness.keyTimes.slice(1).map((time, index) => time - harness.keyTimes[index]!)
      ).toEqual(Array(157).fill(AGENT_TUI_COMMAND_KEY_INTERVAL_MS))
      expect(harness.writes).toHaveLength(160)
      expect(harness.writes[158]).toBe(
        `${AGENT_PROMPT_BRACKETED_PASTE_START}new prompt\nsecond line${AGENT_PROMPT_BRACKETED_PASTE_END}`
      )
      expect(harness.writes[159]).toBe('\r')
      expect(harness.submitted).toEqual(['new prompt\nsecond line'])
      const writes = [...harness.writes]
      await expect(harness.dispatcher.dispatch(request)).resolves.toMatchObject({
        ok: true,
        result: { mutation: { replayed: true } }
      })
      expect(harness.writes).toEqual(writes)
      harness.db.close()
    }
  )

  it('starts the paste render gate after the clear cadence, not at the first control key', async () => {
    vi.useFakeTimers()
    const harness = await createHarness()
    const gate = vi.fn(() => ({ arm: vi.fn(), wait: async () => undefined, dispose: vi.fn() }))
    const createdAt: number[] = []
    // Why: observe the existing gate boundary without replacing the asserted write path.
    Object.defineProperty(harness.runtime, 'createAgentPromptRenderGate', {
      value: () => {
        createdAt.push(Date.now())
        return gate()
      }
    })
    const pending = harness.dispatcher.dispatch(sendRequest(harness.handle, 'gate-after-clear'))
    await vi.runAllTimersAsync()
    await pending
    expect(createdAt).toEqual([harness.keyTimes.at(-1)])
    expect(gate).toHaveBeenCalledTimes(1)
    harness.db.close()
  })

  it('finishes the clear and prompt when the transport disconnects after the first effect', async () => {
    vi.useFakeTimers()
    const harness = await createHarness(0.5)
    const controller = new AbortController()
    harness.afterWrite(() => controller.abort())
    const pending = harness.dispatcher.dispatch(sendRequest(harness.handle, 'disconnect-clear'), {
      signal: controller.signal
    })
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toMatchObject({ ok: true, result: { send: { accepted: true } } })
    expect(harness.writes).toHaveLength(160)
    expect(harness.submitted).toEqual(['new prompt\nsecond line'])
    harness.db.close()
  })

  it.each(['provider', 'permission', 'generation'] as const)(
    'stops after a %s change during the clear and never replays partial effects',
    async (change) => {
      vi.useFakeTimers()
      const harness = await createHarness()
      harness.afterWrite(() => {
        if (harness.writes.length !== 3) {
          return
        }
        if (change === 'provider') {
          harness.setForeground('codex')
        }
        if (change === 'permission') {
          harness.runtime.onPtyData(
            'pty-prompt',
            '\x1b]9999;{"state":"waiting","agentType":"claude"}\x07',
            Date.now()
          )
        }
        if (change === 'generation') {
          harness.runtime.synchronizePtyOutputSequenceFromProvider(
            'pty-prompt',
            { value: 0, generation: 'reset' },
            harness.runtime.getPtyOutputSequence('pty-prompt')
          )
        }
      })
      const request = sendRequest(harness.handle, `partial-${change}`)
      const reply = vi.fn()
      const pending = harness.dispatcher.dispatchStreaming(request, reply)
      await vi.runAllTimersAsync()
      await pending
      expect(JSON.parse(reply.mock.calls.at(-1)![0])).toMatchObject({ ok: false })
      expect(harness.writes).toEqual([...AGENT_TUI_CLEAR_INPUT_MAX].slice(0, 3))
      expect(harness.submitted).toEqual([])
      await harness.dispatcher.dispatchStreaming(
        {
          id: 'read',
          authToken: 'token',
          method: 'orchestration.requestShow',
          params: { request: `partial-${change}` }
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
      expect(harness.writes).toHaveLength(3)
      harness.db.close()
    }
  )

  it('rechecks the provider after the last clear key before writing any prompt body', async () => {
    vi.useFakeTimers()
    const harness = await createHarness()
    harness.afterWrite(() => {
      if (harness.writes.length === 158) {
        harness.setForeground('zsh')
      }
    })
    const pending = harness.dispatcher.dispatch(sendRequest(harness.handle, 'last-key-exit'))
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toMatchObject({ ok: false })
    expect(harness.writes).toEqual([...AGENT_TUI_CLEAR_INPUT_MAX])
    expect(harness.submitted).toEqual([])
    harness.db.close()
  })
})
