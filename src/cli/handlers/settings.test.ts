import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const { closeSpies } = vi.hoisted(() => {
  const closeSpies: { mock: { calls: unknown[] } }[] = []
  return { closeSpies }
})

// Why wrap open: proving the descriptor is closed on every rejection needs the real handle.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      closeSpies.push(vi.spyOn(handle, 'close'))
      return handle
    }
  }
})

import { SETTINGS_FILE_MAX_BYTES, SETTINGS_HANDLERS } from './settings'
import type { HandlerContext } from '../dispatch'
import { RuntimeClient, RuntimeClientError } from '../runtime-client'

const SECRET = 'SECRET-VALUE'

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

describe('orca settings CLI handlers', () => {
  let dir: string
  let client: RuntimeClient
  let callSpy: MockInstance<RuntimeClient['call']>
  let logSpy: MockInstance<Console['log']>

  function run(
    command: 'settings get' | 'settings update',
    flags: [string, string][] = [],
    json = true
  ): Promise<void> {
    const ctx: HandlerContext = { flags: new Map(flags), client, cwd: dir, json }
    return SETTINGS_HANDLERS[command](ctx)
  }

  function writeSettingsFile(content: string | Buffer): string {
    writeFileSync(join(dir, 'settings.json'), content)
    return 'settings.json'
  }

  function respond(settings: Record<string, unknown>) {
    return { id: 'r', ok: true as const, result: { settings }, _meta: { runtimeId: 'rt' } }
  }

  function printed(): string {
    return logSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-settings-cli-'))
    client = new RuntimeClient(join(dir, 'user-data'), 1_000, null, null, 'orca')
    callSpy = vi.spyOn(client, 'call').mockRejectedValue(new Error('unexpected runtime call'))
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    closeSpies.length = 0
  })

  afterEach(() => {
    logSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  it.each([true, false])('prints only the safe projection for get (json=%s)', async (json) => {
    callSpy.mockResolvedValueOnce(
      respond({
        agentCmdOverrides: { claude: `claude --token=${SECRET}`, codex: '' },
        agentDefaultEnv: { claude: { API_KEY: SECRET } },
        agentDefaultArgs: { claude: `--key ${SECRET}` },
        defaultTuiAgent: 'claude',
        disabledTuiAgents: ['gemini'],
        agentStatusHooksEnabled: true
      })
    )

    await run('settings get', [], json)

    expect(callSpy).toHaveBeenCalledWith('settings.get')
    expect(printed()).not.toContain(SECRET)
    if (json) {
      expect(JSON.parse(printed())).toMatchObject({
        result: {
          agentCmdOverrides: { claude: { configured: true } },
          defaultTuiAgent: 'claude',
          disabledTuiAgents: ['gemini'],
          agentStatusHooksEnabled: true
        }
      })
      expect(Object.keys(JSON.parse(printed()).result).sort()).toEqual([
        'agentCmdOverrides',
        'agentStatusHooksEnabled',
        'defaultTuiAgent',
        'disabledTuiAgents'
      ])
    } else {
      expect(printed()).toContain('agentCmdOverrides configured for: claude')
    }
  })

  it.each([true, false])('does not echo unknown host agent identifiers (json=%s)', async (json) => {
    callSpy.mockResolvedValueOnce(
      respond({
        agentCmdOverrides: { [SECRET]: 'configured', claude: 'valid' },
        defaultTuiAgent: SECRET,
        disabledTuiAgents: [SECRET, 'codex']
      })
    )
    await run('settings get', [], json)
    expect(printed()).not.toContain(SECRET)
    expect(printed()).toContain('claude')
    expect(printed()).toContain('codex')
  })

  it.each([true, false])(
    'applies the overrides once, compares the raw readback, and prints names only (json=%s)',
    async (json) => {
      const file = writeSettingsFile(
        JSON.stringify({ agentCmdOverrides: { claude: ` /opt/claude ${SECRET} `, codex: 'cx' } })
      )
      callSpy
        .mockResolvedValueOnce(respond({}))
        .mockResolvedValueOnce(
          respond({ agentCmdOverrides: { claude: `/opt/claude ${SECRET}`, codex: 'cx' } })
        )

      await run('settings update', [['file', file]], json)

      expect(callSpy.mock.calls).toEqual([
        [
          'settings.update',
          { agentCmdOverrides: { claude: `/opt/claude ${SECRET}`, codex: 'cx' } }
        ],
        ['settings.get']
      ])
      expect(printed()).not.toContain(SECRET)
      if (json) {
        expect(JSON.parse(printed()).result).toEqual({ configuredAgents: ['claude', 'codex'] })
      } else {
        expect(printed()).toBe('agentCmdOverrides configured for: claude, codex')
      }
      expect(closeSpies.length).toBe(1)
      expect(closeSpies[0]?.mock.calls.length).toBe(1)
    }
  )

  it('fails when the raw readback differs from what was requested', async () => {
    const file = writeSettingsFile(JSON.stringify({ agentCmdOverrides: { claude: 'x' } }))
    callSpy
      .mockResolvedValueOnce(respond({}))
      .mockResolvedValueOnce(respond({ agentCmdOverrides: { claude: 'y' } }))

    const error = await captureError(run('settings update', [['file', file]]))

    expect(error).toMatchObject({ code: 'runtime_error' })
  })

  it('surfaces an old server rejection without retrying', async () => {
    const file = writeSettingsFile(JSON.stringify({ agentCmdOverrides: { claude: 'x' } }))
    callSpy.mockRejectedValueOnce(new RuntimeClientError('invalid_argument', 'Unrecognized key'))

    const error = await captureError(run('settings update', [['file', file]]))

    expect(error).toMatchObject({ code: 'invalid_argument' })
    expect(callSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['invalid JSON', `{"agentCmdOverrides": {"claude": "${SECRET}"`],
    ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d])],
    ['non-object JSON', '[]'],
    ['other settings keys', JSON.stringify({ agentStatusHooksEnabled: false })],
    ['a secret as a top-level key', JSON.stringify({ agentCmdOverrides: {}, [SECRET]: 1 })],
    ['a secret as an agent id', JSON.stringify({ agentCmdOverrides: { [SECRET]: 'x' } })],
    ['non-string command', JSON.stringify({ agentCmdOverrides: { claude: [SECRET] } })],
    ['multi-line command', JSON.stringify({ agentCmdOverrides: { claude: `a\n${SECRET}` } })]
  ])('rejects %s before calling the runtime and closes the file', async (_label, content) => {
    const file = writeSettingsFile(content)

    const error = await captureError(run('settings update', [['file', file]]))

    expect(error).toMatchObject({ code: 'invalid_argument' })
    expect(error.message).not.toContain(SECRET)
    expect(callSpy).not.toHaveBeenCalled()
    expect(closeSpies.length).toBe(1)
    expect(closeSpies[0]?.mock.calls.length).toBe(1)
  })

  it('rejects a file past the limit from the bytes actually read', async () => {
    const file = writeSettingsFile(
      JSON.stringify({ agentCmdOverrides: { claude: 'x'.repeat(SETTINGS_FILE_MAX_BYTES) } })
    )

    const error = await captureError(run('settings update', [['file', file]]))

    expect(error).toMatchObject({ code: 'invalid_argument' })
    expect(error.message).toContain(`${SETTINGS_FILE_MAX_BYTES} bytes`)
    expect(callSpy).not.toHaveBeenCalled()
    expect(closeSpies[0]?.mock.calls.length).toBe(1)
  })

  it('accepts a file of exactly the limit', async () => {
    const body = JSON.stringify({ agentCmdOverrides: { claude: 'x' } })
    const file = writeSettingsFile(body.padEnd(SETTINGS_FILE_MAX_BYTES, ' '))
    callSpy
      .mockResolvedValueOnce(respond({}))
      .mockResolvedValueOnce(respond({ agentCmdOverrides: { claude: 'x' } }))

    await run('settings update', [['file', file]])

    expect(callSpy).toHaveBeenCalledTimes(2)
  })

  it('rejects a directory without reading it', async () => {
    mkdirSync(join(dir, 'folder'))

    const error = await captureError(run('settings update', [['file', 'folder']]))

    expect(error).toMatchObject({ code: 'invalid_argument' })
    expect(callSpy).not.toHaveBeenCalled()
    for (const close of closeSpies) {
      expect(close.mock.calls.length).toBe(1)
    }
  })

  // Why the skip: FIFOs are a POSIX shape; Windows has no mkfifo and no equivalent hazard here.
  it.skipIf(process.platform === 'win32')(
    'rejects a FIFO with no writer instead of blocking',
    async () => {
      await promisify(execFile)('mkfifo', [join(dir, 'pipe')])

      const error = await captureError(run('settings update', [['file', 'pipe']]))

      expect(error).toMatchObject({ code: 'invalid_argument' })
      expect(error.message).toContain('regular file')
      expect(callSpy).not.toHaveBeenCalled()
      expect(closeSpies[0]?.mock.calls.length).toBe(1)
    },
    5_000
  )

  it('requires --file and rejects unreadable paths', async () => {
    expect(await captureError(run('settings update'))).toMatchObject({ code: 'invalid_argument' })
    expect(await captureError(run('settings update', [['file', 'missing.json']]))).toMatchObject({
      code: 'invalid_argument'
    })
    expect(callSpy).not.toHaveBeenCalled()
  })
})
