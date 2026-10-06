import { describe, expect, it, vi } from 'vitest'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import { RuntimePtyForegroundAgent } from './runtime-pty-foreground-agent'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

function createPty(): RuntimePtyWorktreeRecord {
  return {
    tailBuffer: [],
    tailTranscriptBuffer: [],
    tailTranscriptChars: 0,
    tailPartialLine: '',
    tailPendingAnsi: '',
    tailRedrawCursor: null,
    tailTruncated: false,
    tailLinesTotal: 0,
    preview: '',
    waitBlockedAt: null,
    ptyId: 'pty-1',
    incarnationId: 'inc-1',
    worktreeId: 'wt-1',
    connectionId: null,
    runtimeSessionOwned: false,
    isWsl: null,
    wslDistro: null,
    tabId: null,
    paneKey: null,
    surfaceRecordedAtGraphSequence: 0,
    launchConfig: null,
    launchToken: null,
    launchIncarnationId: null,
    launchAgent: null,
    agentSessionOwners: [],
    foregroundAgent: 'codex',
    connected: true,
    disconnectedAt: null,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastAgentStatusObservedLive: false,
    lastAgentStatusStartedAtEpochMs: null,
    lastAgentStatusRichInvalidatedAtEpochMs: null,
    lastOscTitle: null,
    lastOscTitleAt: null,
    lastOscTitleEpochMs: null,
    managementTitle: null,
    managementTitleAt: null,
    controllerTitle: null,
    title: null,
    titleUpdatedAt: null,
    lastOutputAt: null
  }
}

// Models the daemon tracker: an agent answer is cached for 1s; once expired the raw read
// returns the shell fallback and only refreshes the cache asynchronously.
function createHarness(options: { withConfirm?: boolean } = {}) {
  const clock = { now: 0, scannedAt: 0, liveProcess: 'codex' }
  const getForegroundProcess = vi.fn(async (): Promise<string | null> => {
    if (clock.now - clock.scannedAt <= 1000) {
      return clock.liveProcess
    }
    queueMicrotask(() => {
      clock.scannedAt = clock.now
    })
    return 'bash'
  })
  const confirmForegroundProcess = vi.fn(async (): Promise<string | null> => {
    clock.scannedAt = clock.now
    return clock.liveProcess
  })
  const controller: RuntimePtyController = {
    write: () => true,
    kill: () => true,
    getForegroundProcess,
    ...(options.withConfirm === false ? {} : { confirmForegroundProcess })
  }
  const pty = createPty()
  const current: { controller: RuntimePtyController | null; pty: RuntimePtyWorktreeRecord } = {
    controller,
    pty
  }
  const touchSnapshot = vi.fn()
  const agent = new RuntimePtyForegroundAgent({
    getController: () => current.controller,
    getPty: (ptyId) => (ptyId === current.pty.ptyId ? current.pty : null),
    touchSnapshot,
    finishDelayedSnapshot: vi.fn()
  })
  return {
    clock,
    pty,
    current,
    agent,
    touchSnapshot,
    getForegroundProcess,
    confirmForegroundProcess
  }
}

function holdConfirmation(harness: ReturnType<typeof createHarness>) {
  const held: { release?: (process: string | null) => void } = {}
  harness.confirmForegroundProcess.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        held.release = resolve
      })
  )
  return held
}

describe('RuntimePtyForegroundAgent', () => {
  it('keeps a live agent identity when refreshes are spaced past the provider cache TTL', async () => {
    const h = createHarness()
    for (const now of [1500, 3000, 4500]) {
      h.clock.now = now
      await expect(h.agent.refresh(h.pty.ptyId)).resolves.toBe(false)
      expect(h.pty.foregroundAgent).toBe('codex')
    }
    expect(h.confirmForegroundProcess).toHaveBeenCalledTimes(3)
    expect(h.touchSnapshot).not.toHaveBeenCalled()
  })

  it('clears the identity when the confirmed foreground is no longer an agent', async () => {
    const h = createHarness()
    h.clock.liveProcess = 'bash'
    h.clock.now = 1500
    await expect(h.agent.refresh(h.pty.ptyId)).resolves.toBe(true)
    expect(h.pty.foregroundAgent).toBeNull()
    expect(h.touchSnapshot).toHaveBeenCalledWith(h.pty.ptyId)
  })

  it('skips confirmation when the raw answer is already a recognized agent', async () => {
    const h = createHarness()
    h.pty.foregroundAgent = null
    h.clock.now = 500
    await expect(h.agent.refresh(h.pty.ptyId)).resolves.toBe(true)
    expect(h.pty.foregroundAgent).toBe('codex')
    expect(h.confirmForegroundProcess).not.toHaveBeenCalled()
  })

  it('keeps raw reads cheap even when the answer is unrecognized', async () => {
    const h = createHarness()
    h.clock.now = 1500
    await expect(h.agent.read(h.pty.ptyId)).resolves.toMatchObject({
      process: 'bash',
      available: true
    })
    expect(h.confirmForegroundProcess).not.toHaveBeenCalled()
  })

  it('preserves old behavior for null answers and controllers without confirmation', async () => {
    const h = createHarness()
    h.getForegroundProcess.mockResolvedValueOnce(null)
    await expect(h.agent.refresh(h.pty.ptyId)).resolves.toBe(true)
    expect(h.pty.foregroundAgent).toBeNull()
    expect(h.confirmForegroundProcess).not.toHaveBeenCalled()

    const legacy = createHarness({ withConfirm: false })
    legacy.clock.now = 1500
    await expect(legacy.agent.refresh(legacy.pty.ptyId)).resolves.toBe(true)
    expect(legacy.pty.foregroundAgent).toBeNull()
  })

  it('keeps the identity when confirmation fails', async () => {
    const h = createHarness()
    h.confirmForegroundProcess.mockRejectedValueOnce(new Error('scan failed'))
    h.clock.now = 1500
    await expect(h.agent.refresh(h.pty.ptyId)).resolves.toBe(false)
    expect(h.pty.foregroundAgent).toBe('codex')
    expect(h.touchSnapshot).not.toHaveBeenCalled()
  })

  type Harness = ReturnType<typeof createHarness>
  it.each<[string, (h: Harness) => void]>([
    [
      'stopped',
      (h) => {
        h.pty.connected = false
      }
    ],
    [
      'replaced',
      (h) => {
        h.current.pty = createPty()
      }
    ],
    [
      'reincarnated',
      (h) => {
        h.pty.incarnationId = 'inc-2'
      }
    ],
    [
      'detached from its controller',
      (h) => {
        h.current.controller = null
      }
    ]
  ])('does not publish when the PTY is %s during confirmation', async (_label, mutate) => {
    const h = createHarness()
    const held = holdConfirmation(h)
    h.clock.now = 1500
    const refresh = h.agent.refresh(h.pty.ptyId)
    await vi.waitFor(() => expect(h.confirmForegroundProcess).toHaveBeenCalledTimes(1))
    mutate(h)
    held.release?.('bash')
    await expect(refresh).resolves.toBe(false)
    expect(h.pty.foregroundAgent).toBe('codex')
    expect(h.current.pty.foregroundAgent).toBe('codex')
    expect(h.touchSnapshot).not.toHaveBeenCalled()
  })

  it('coalesces concurrent refreshes onto one confirmation', async () => {
    const h = createHarness()
    const held = holdConfirmation(h)
    h.clock.now = 1500
    const first = h.agent.refresh(h.pty.ptyId)
    const second = h.agent.refresh(h.pty.ptyId)
    expect(second).toBe(first)
    await vi.waitFor(() => expect(h.confirmForegroundProcess).toHaveBeenCalledTimes(1))
    held.release?.('codex')
    await expect(first).resolves.toBe(false)
    expect(h.confirmForegroundProcess).toHaveBeenCalledTimes(1)
  })
})
