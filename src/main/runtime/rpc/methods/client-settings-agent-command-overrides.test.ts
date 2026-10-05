import { describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AGENT_CMD_OVERRIDE_MAX_LENGTH } from '../../../../shared/rpc-contract/client-settings-params'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RuntimeClientSettingsController } from '../../runtime-client-settings'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'

const { applyAgentStatusHooksEnabled } = vi.hoisted(() => ({
  applyAgentStatusHooksEnabled: vi.fn(async () => [])
}))

vi.mock('../../../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled
}))

function makeRequest(params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'settings.update', params }
}

// Why a real controller over a mocked runtime: the projection and the store merge are what a
// paired client observes, and only exercising both proves the override survives the round trip.
function createHarness(initial: Partial<GlobalSettings> = {}) {
  const settings = createGlobalSettingsFixture({ workspaceDir: '/w', ...initial })
  const updateSettings = vi.fn((updates: Partial<GlobalSettings>) =>
    Object.assign(settings, updates)
  )
  const controller = new RuntimeClientSettingsController({
    getSettings: () => settings,
    updateSettings
  })
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getClientSettings: () => controller.get(),
    updateClientSettings: (updates: Parameters<RuntimeClientSettingsController['update']>[0]) =>
      controller.update(updates)
  }
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settings.get/update and dispatcher metadata reach only these three runtime members.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: CLIENT_UI_METHODS
  })
  return { settings, updateSettings, dispatcher }
}

describe('settings.update agentCmdOverrides', () => {
  it('persists trimmed overrides and projects them back through settings.get', async () => {
    const { settings, dispatcher } = createHarness({ agentCmdOverrides: { gemini: 'old' } })

    const response = await dispatcher.dispatch(
      makeRequest({
        agentCmdOverrides: {
          claude: '  /opt/bin/claude --model x  ',
          codex: 'codex-wrapper',
          gemini: ''
        }
      })
    )

    const expected = { claude: '/opt/bin/claude --model x', codex: 'codex-wrapper' }
    expect(response).toMatchObject({
      ok: true,
      result: { settings: { agentCmdOverrides: expected } }
    })
    expect(settings.agentCmdOverrides).toEqual(expected)
    const readback = await dispatcher.dispatch({
      id: 'req-2',
      authToken: 'tok',
      method: 'settings.get'
    })
    expect(readback).toMatchObject({
      ok: true,
      result: { settings: { agentCmdOverrides: settings.agentCmdOverrides } }
    })
  })

  it('leaves unrelated settings and managed hooks untouched', async () => {
    const { settings, updateSettings, dispatcher } = createHarness({
      agentStatusHooksEnabled: true,
      disabledTuiAgents: ['gemini'],
      agentDefaultArgs: { claude: '--verbose' },
      agentDefaultEnv: { codex: { FOO: 'bar' } },
      defaultTuiAgent: 'codex'
    })

    await dispatcher.dispatch(makeRequest({ agentCmdOverrides: { claude: 'claude-wrapper' } }))

    expect(updateSettings).toHaveBeenCalledWith(
      { agentCmdOverrides: { claude: 'claude-wrapper' } },
      { notifyListeners: true }
    )
    expect(settings).toMatchObject({
      agentStatusHooksEnabled: true,
      disabledTuiAgents: ['gemini'],
      agentDefaultArgs: { claude: '--verbose' },
      agentDefaultEnv: { codex: { FOO: 'bar' } },
      defaultTuiAgent: 'codex'
    })
    expect(applyAgentStatusHooksEnabled).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown agent id', { agentCmdOverrides: { 'not-an-agent': 'x' } }],
    ['non-string command', { agentCmdOverrides: { claude: 42 } }],
    ['non-object map', { agentCmdOverrides: 'claude' }],
    ['null map', { agentCmdOverrides: null }],
    ['array map', { agentCmdOverrides: ['claude'] }],
    ['multi-line command', { agentCmdOverrides: { claude: 'claude\nrm -rf /' } }],
    [
      'oversized command',
      { agentCmdOverrides: { claude: 'x'.repeat(AGENT_CMD_OVERRIDE_MAX_LENGTH + 1) } }
    ],
    ['unknown sibling key', { agentCmdOverrides: { claude: 'x' }, agentCmdOverride: {} }]
  ])('rejects %s without saving anything', async (_label, params) => {
    const { settings, updateSettings, dispatcher } = createHarness({
      agentCmdOverrides: { codex: 'kept' }
    })

    const response = await dispatcher.dispatch(makeRequest(params))

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(updateSettings).not.toHaveBeenCalled()
    expect(settings.agentCmdOverrides).toEqual({ codex: 'kept' })
  })

  it.each([
    ['command text', { claude: 'claude --token=SECRET-VALUE\n' }],
    ['unknown agent key', { 'SECRET-VALUE': 'claude' }],
    ['non-string value under an unknown key', { 'SECRET-VALUE': 1 }]
  ])('does not echo the rejected %s in the error', async (_label, agentCmdOverrides) => {
    const { dispatcher } = createHarness()

    const response = await dispatcher.dispatch(makeRequest({ agentCmdOverrides }))

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(JSON.stringify(response)).not.toContain('SECRET-VALUE')
  })
})
