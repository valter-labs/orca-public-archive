import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { parseAgentCmdOverrides } from '../../shared/rpc-contract/client-settings-params'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgent } from '../../shared/tui-agent-config'

export const SETTINGS_FILE_MAX_BYTES = 64 * 1024

type AgentCmdOverrides = Partial<Record<TuiAgent, string>>

// Why unknown values: the host is another Orca version whose projection is checked, not trusted.
type RuntimeClientSettings = Record<string, unknown>

function stringEntries(value: unknown): [string, string][] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return []
  }
  return Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )
}

// Why a fixed projection: command overrides and agent env values can embed credentials, and this
// output lands in terminals and logs. Never print raw command or env text.
type SafeSettingsProjection = {
  agentCmdOverrides: Record<string, { configured: true }>
  defaultTuiAgent: string | null
  disabledTuiAgents: string[]
  agentStatusHooksEnabled: boolean
}

type SafeSettingsUpdateResult = { configuredAgents: string[] }

function configuredAgentNames(overrides: unknown): string[] {
  return stringEntries(overrides)
    .filter(([agent, command]) => isTuiAgent(agent) && command.length > 0)
    .map(([agent]) => agent)
    .sort()
}

function projectSafeSettings(settings: RuntimeClientSettings): SafeSettingsProjection {
  const { defaultTuiAgent, disabledTuiAgents } = settings
  return {
    agentCmdOverrides: Object.fromEntries(
      configuredAgentNames(settings.agentCmdOverrides).map((agent) => [agent, { configured: true }])
    ),
    defaultTuiAgent:
      defaultTuiAgent === 'blank' || isTuiAgent(defaultTuiAgent) ? defaultTuiAgent : null,
    disabledTuiAgents: Array.isArray(disabledTuiAgents)
      ? disabledTuiAgents.filter((agent): agent is TuiAgent => isTuiAgent(agent))
      : [],
    agentStatusHooksEnabled: settings.agentStatusHooksEnabled !== false
  }
}

function invalidFile(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

// Why one descriptor: a stat-then-read pair can see a different file, and a FIFO would block
// forever. O_NONBLOCK keeps a FIFO open from waiting for a writer; Windows has no such flag.
async function readSettingsFileBytes(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch(() => {
    throw invalidFile('Could not open the settings file.')
  })
  try {
    if (!(await handle.stat()).isFile()) {
      throw invalidFile('Settings file must be a regular file.')
    }
    // One byte past the limit proves oversize from what was actually read, not a stale size.
    const buffer = Buffer.alloc(SETTINGS_FILE_MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) {
        break
      }
      length += bytesRead
    }
    if (length > SETTINGS_FILE_MAX_BYTES) {
      throw invalidFile(`Settings file is larger than ${SETTINGS_FILE_MAX_BYTES} bytes.`)
    }
    return buffer.subarray(0, length)
  } catch (error) {
    if (error instanceof RuntimeClientError) {
      throw error
    }
    throw invalidFile('Could not read the settings file.')
  } finally {
    await handle.close()
  }
}

function parseSettingsFile(bytes: Buffer): AgentCmdOverrides {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    // Why generic: JSON.parse messages quote file content, which may hold credentials.
    throw invalidFile('Settings file is not valid UTF-8 JSON.')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidFile('Settings file must be a JSON object.')
  }
  // Why only this key: the file is the unattended bootstrap surface, so it must not become a back
  // door for hook, privacy, or other host-owned settings the full RPC schema accepts. Key names are
  // never echoed because they are caller-controlled.
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'agentCmdOverrides') {
    throw invalidFile('Settings file must contain only the agentCmdOverrides key.')
  }
  const parsed = parseAgentCmdOverrides(Object.values(value)[0])
  if (!parsed.ok) {
    throw invalidFile(`Invalid settings file: ${parsed.error}.`)
  }
  return parsed.overrides
}

function sameOverrides(saved: unknown, requested: AgentCmdOverrides): boolean {
  const savedRecord = saved ?? {}
  if (typeof savedRecord !== 'object' || Array.isArray(savedRecord)) {
    return false
  }
  const savedEntries = Object.entries(savedRecord)
  const requestedByAgent = new Map<string, string | undefined>(Object.entries(requested))
  return (
    savedEntries.length === requestedByAgent.size &&
    savedEntries.every(([agent, command]) => requestedByAgent.get(agent) === command)
  )
}

function formatSettings(result: SafeSettingsProjection): string {
  const configured = Object.keys(result.agentCmdOverrides)
  return [
    `defaultTuiAgent: ${result.defaultTuiAgent ?? 'none'}`,
    `disabledTuiAgents: ${result.disabledTuiAgents.join(', ') || 'none'}`,
    `agentStatusHooksEnabled: ${result.agentStatusHooksEnabled}`,
    `agentCmdOverrides configured for: ${configured.join(', ') || 'none'}`
  ].join('\n')
}

function formatUpdate(result: SafeSettingsUpdateResult): string {
  return `agentCmdOverrides configured for: ${result.configuredAgents.join(', ') || 'none'}`
}

export const SETTINGS_HANDLERS: Record<string, CommandHandler> = {
  'settings get': async ({ client, json }) => {
    const response = await client.call<{ settings: RuntimeClientSettings }>('settings.get')
    printResult(
      { ...response, result: projectSafeSettings(response.result.settings) },
      json,
      formatSettings
    )
  },
  'settings update': async ({ client, flags, cwd, json }) => {
    const file = flags.get('file')
    if (typeof file !== 'string' || file.length === 0) {
      throw invalidFile('Missing required --file <path>.')
    }
    const overrides = parseSettingsFile(await readSettingsFileBytes(resolve(cwd, file)))
    // Why no fallback: a host that rejects the key must not be coerced through another channel.
    await client.call('settings.update', { agentCmdOverrides: overrides })
    // The readback compares raw commands so a host that normalizes differently is caught.
    const readback = await client.call<{ settings: RuntimeClientSettings }>('settings.get')
    if (!sameOverrides(readback.result.settings.agentCmdOverrides, overrides)) {
      throw new RuntimeClientError(
        'runtime_error',
        'Saved agentCmdOverrides differ from the requested file after update.'
      )
    }
    printResult(
      { ...readback, result: { configuredAgents: configuredAgentNames(overrides) } },
      json,
      formatUpdate
    )
  }
}
