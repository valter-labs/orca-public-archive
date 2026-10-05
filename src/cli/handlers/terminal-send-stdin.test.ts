import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { RuntimeClient } from '../runtime-client'
import { readTerminalSendStdin, TERMINAL_SEND_STDIN_MAX_BYTES } from './terminal-send'
import { TERMINAL_HANDLERS } from './terminal'

const ORIGINAL_EXIT_CODE = process.exitCode
const ORIGINAL_STDIN = Object.getOwnPropertyDescriptor(process, 'stdin')

function pipedStdin(...chunks: Buffer[]): Readable {
  return Readable.from(chunks)
}

function replaceStdin(stdin: Readable): void {
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) {
      return error
    }
    throw error
  }
  throw new Error('expected the command to fail')
}

describe('readTerminalSendStdin', () => {
  it('returns piped multi-line UTF-8 text unchanged', async () => {
    const text = 'review this\n\tplease ✓\n'
    await expect(readTerminalSendStdin(pipedStdin(Buffer.from(text)))).resolves.toBe(text)
  })

  it('accepts exactly the byte limit, counted in bytes rather than characters', async () => {
    // '✓' is three UTF-8 bytes, so the character count sits well under the byte limit.
    const text = '✓'.repeat(1_000) + 'x'.repeat(TERMINAL_SEND_STDIN_MAX_BYTES - 3_000)
    expect(Buffer.byteLength(text)).toBe(TERMINAL_SEND_STDIN_MAX_BYTES)
    expect(text.length).toBeLessThan(TERMINAL_SEND_STDIN_MAX_BYTES)
    await expect(readTerminalSendStdin(pipedStdin(Buffer.from(text)))).resolves.toBe(text)
  })

  it.each([
    ['a TTY', Object.assign(pipedStdin(Buffer.from('x')), { isTTY: true }), 'not a TTY'],
    ['empty input', pipedStdin(), 'empty'],
    ['invalid UTF-8', pipedStdin(Buffer.from([0x68, 0xff])), 'UTF-8'],
    ['an escape sequence', pipedStdin(Buffer.from('hi\u001b[2J')), 'control characters'],
    ['a NUL byte', pipedStdin(Buffer.from('hi\u0000')), 'control characters'],
    [
      'input past the limit across chunks',
      pipedStdin(Buffer.alloc(TERMINAL_SEND_STDIN_MAX_BYTES, 0x61), Buffer.from('b')),
      `${TERMINAL_SEND_STDIN_MAX_BYTES} bytes`
    ]
  ])('rejects %s', async (_label, stdin, message) => {
    const error = await captureError(readTerminalSendStdin(stdin))
    expect(error).toMatchObject({ code: 'invalid_argument' })
    expect(error.message).toContain(message)
  })
})

describe('terminal send --text-stdin', () => {
  let dir: string
  let client: RuntimeClient
  let callSpy: MockInstance<RuntimeClient['call']>

  const sendReceipt = {
    id: 'r',
    ok: true as const,
    result: {
      send: {
        handle: 'term-1',
        accepted: true,
        bytesWritten: 7,
        prompt: {
          requestId: '11111111-1111-4111-8111-111111111111',
          stages: ['input_accepted'],
          provider: 'codex',
          observation: 'supported',
          processIncarnation: 'inc-1',
          generation: 1,
          baselineWorkingSequence: 0
        }
      }
    },
    _meta: { runtimeId: 'runtime-current' }
  }

  function send(flags: [string, string | true][]): Promise<void> {
    return TERMINAL_HANDLERS['terminal send']({
      flags: new Map<string, string | boolean>([['terminal', 'term-1'], ...flags]),
      client,
      cwd: dir,
      json: true
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-terminal-send-stdin-'))
    client = new RuntimeClient(join(dir, 'user-data'), 1_000, null, null, 'orca')
    callSpy = vi.spyOn(client, 'call').mockResolvedValue(sendReceipt)
    vi.spyOn(client, 'getCliStatus').mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        app: { running: true, pid: 1 },
        runtime: {
          state: 'ready',
          reachable: true,
          runtimeId: 'runtime-current',
          capabilities: [TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY]
        },
        graph: { state: 'ready' }
      },
      _meta: { runtimeId: 'runtime-current' }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    if (ORIGINAL_STDIN) {
      Object.defineProperty(process, 'stdin', ORIGINAL_STDIN)
    }
    vi.restoreAllMocks()
    process.exitCode = ORIGINAL_EXIT_CODE
    rmSync(dir, { recursive: true, force: true })
  })

  it('makes the same prompt call as --text, with retry identity and wait preserved', async () => {
    const shared: [string, string | true][] = [
      ['enter', true],
      ['retry-request', '22222222-2222-4222-8222-222222222222'],
      ['wait-submit', '5']
    ]
    await send([['text', 'private prompt'], ...shared])
    replaceStdin(pipedStdin(Buffer.from('private prompt')))
    await send([['text-stdin', true], ...shared])

    expect(callSpy).toHaveBeenCalledTimes(2)
    expect(callSpy.mock.calls[1]).toEqual(callSpy.mock.calls[0])
    expect(callSpy.mock.calls[0]).toEqual([
      'terminal.send',
      {
        terminal: 'term-1',
        text: 'private prompt',
        enter: true,
        interrupt: false,
        agentPrompt: true,
        waitSubmitMs: 5_000,
        client: { id: 'orca-cli', type: 'desktop' }
      },
      {
        terminalPromptPreflight: { runtimeId: 'runtime-current' },
        orchestrationRequestId: '22222222-2222-4222-8222-222222222222',
        timeoutMs: 15_000
      }
    ])
  })

  it('rejects combining --text with --text-stdin before reading or sending', async () => {
    const stdin = pipedStdin(Buffer.from('ignored'))
    replaceStdin(stdin)

    const error = await captureError(
      send([
        ['text', 'a'],
        ['text-stdin', true]
      ])
    )

    expect(error).toMatchObject({ code: 'invalid_argument' })
    expect(stdin.readableEnded).toBe(false)
    expect(callSpy).not.toHaveBeenCalled()
  })

  it('sends nothing when stdin input is rejected', async () => {
    replaceStdin(pipedStdin(Buffer.from('bad\u001b')))

    const error = await captureError(
      send([
        ['text-stdin', true],
        ['enter', true]
      ])
    )

    expect(error).toMatchObject({ code: 'invalid_argument' })
    expect(callSpy).not.toHaveBeenCalled()
  })
})
