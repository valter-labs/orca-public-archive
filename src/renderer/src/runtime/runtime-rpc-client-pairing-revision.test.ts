import { beforeEach, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import { callRuntimeRpc, clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'

const runtimeEnvironmentCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  replaceRuntimeEnvironmentRevisions([])
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeEnvironmentCall } } })
})

it('captures the pairing revision before awaiting the compatibility probe', async () => {
  let resolveStatus!: (response: unknown) => void
  replaceRuntimeEnvironmentRevisions([{ id: 'env-cas', createdAt: 1, pairingRevision: 10 }])
  runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
    if (method === 'status.get') {
      return new Promise((resolve) => {
        resolveStatus = resolve
      })
    }
    return Promise.resolve({
      id: method,
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'remote-runtime' }
    })
  })

  const request = callRuntimeRpc({ kind: 'environment', environmentId: 'env-cas' }, 'repo.list')
  await vi.waitFor(() => expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1))
  replaceRuntimeEnvironmentRevisions([{ id: 'env-cas', createdAt: 1, pairingRevision: 11 }])
  resolveStatus({
    id: 'status',
    ok: true,
    result: {
      runtimeId: 'remote-runtime',
      graphStatus: 'ready',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    },
    _meta: { runtimeId: 'remote-runtime' }
  })

  await expect(request).resolves.toEqual({ ok: true })
  expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
    selector: 'env-cas',
    method: 'status.get',
    timeoutMs: undefined,
    expectedEnvironmentPairingRevision: 10
  })
  expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith({
    selector: 'env-cas',
    method: 'repo.list',
    params: undefined,
    timeoutMs: undefined,
    expectedEnvironmentPairingRevision: 10
  })
})

it('forwards only the durable UUID and preserves the captured owner fences', async () => {
  const requestId = '3139988a-2b58-45af-bacb-1e6c518aa955'
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'send',
    ok: true,
    result: { accepted: true },
    _meta: { runtimeId: 'owner' }
  })
  await callRuntimeRpc(
    { kind: 'environment', environmentId: 'env' },
    'terminal.send',
    { text: 'hello' },
    {
      skipCompatibilityCheck: true,
      orchestrationRequestId: requestId,
      expectedEnvironmentPairingRevision: 42,
      expectedEnvironmentRuntimeId: 'owner'
    }
  )
  expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
    expect.objectContaining({
      orchestrationRequestId: requestId,
      expectedEnvironmentPairingRevision: 42,
      expectedEnvironmentRuntimeId: 'owner'
    })
  )
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'send',
    ok: true,
    result: { accepted: true },
    _meta: { runtimeId: 'replacement' }
  })
  await expect(
    callRuntimeRpc(
      { kind: 'environment', environmentId: 'env' },
      'terminal.send',
      {},
      {
        skipCompatibilityCheck: true,
        expectedEnvironmentRuntimeId: 'owner'
      }
    )
  ).rejects.toThrow('runtime_environment_runtime_changed')
})
