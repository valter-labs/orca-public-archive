import { z } from 'zod'
import { isTaskProvider } from '../task-providers'
import type { TaskProvider } from '../task-providers'
import { isTuiAgent } from '../tui-agent-config'
import type { TuiAgent } from '../tui-agent'
import { normalizeDisabledTuiAgents } from '../tui-agent-selection'
import {
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../tui-agent-launch-defaults'
import { MACHINE_NAME_MAX_LENGTH } from '../machine-name'
import { normalizePRBotAuthorOverrides } from '../pr-bot-author-overrides'
import { WorktreeVisibilityDefaultsUpdate } from './worktree-visibility-defaults-params'

export const TaskProviderParam = z.custom<TaskProvider>(isTaskProvider, {
  message: 'Unknown task provider'
})

export const PRBotAuthorOverrideUpdate = z
  .object({ author: z.string(), isBot: z.boolean() })
  .strict()

export const NativeChatSessionOptionPickBase = {
  modelId: z.string().trim().min(1).max(512),
  adoptModelAsLaunchDefault: z.boolean().optional()
}

export const NativeChatSessionOptionPick = z.union([
  z
    .object({
      ...NativeChatSessionOptionPickBase,
      optionId: z.enum(['model', 'effort']),
      value: z.string().trim().min(1).max(512)
    })
    .strict(),
  z
    .object({
      ...NativeChatSessionOptionPickBase,
      optionId: z.enum(['fastMode', 'thinking']),
      value: z.boolean()
    })
    .strict()
])

export const NativeChatSessionOptionsMutation = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('apply-picks'),
      agent: z.enum(['claude', 'codex', 'gemini', 'cursor', 'grok']),
      picks: z.array(NativeChatSessionOptionPick).min(1).max(8)
    })
    .strict(),
  z
    .object({
      type: z.literal('clear-model-if-missing'),
      agent: z.enum(['claude', 'codex', 'gemini', 'cursor', 'grok']),
      availableModelIds: z.array(z.string().trim().min(1).max(512)).min(1).max(256)
    })
    .strict()
])

export const AGENT_CMD_OVERRIDE_MAX_LENGTH = 4096

function hasNoControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      return false
    }
  }
  return true
}

export type AgentCmdOverridesParseResult =
  | { ok: true; overrides: Partial<Record<TuiAgent, string>> }
  | { ok: false; error: string }

/**
 * Strict, unlike agentDefaultArgs: a command override replaces the executable Orca runs, so a
 * typo'd agent id or non-string must fail loudly instead of silently dropping the operator's intent.
 * Errors are fixed strings: keys and values are caller-controlled and may carry credentials.
 */
export function parseAgentCmdOverrides(value: unknown): AgentCmdOverridesParseResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'agentCmdOverrides must be an object' }
  }
  const overrides: Partial<Record<TuiAgent, string>> = {}
  for (const [agent, command] of Object.entries(value)) {
    if (!isTuiAgent(agent)) {
      return { ok: false, error: 'agentCmdOverrides contains an unknown agent id' }
    }
    if (typeof command !== 'string') {
      return { ok: false, error: 'Agent command override must be a string' }
    }
    if (command.length > AGENT_CMD_OVERRIDE_MAX_LENGTH) {
      return { ok: false, error: 'Agent command override is too long' }
    }
    // Why: the override is typed into a terminal; a newline would submit a second command.
    if (!hasNoControlCharacters(command)) {
      return { ok: false, error: 'Agent command override must be a single line' }
    }
    const trimmed = command.trim()
    // Empty matches the desktop editor: clearing the field removes the override.
    if (trimmed) {
      overrides[agent] = trimmed
    }
  }
  return { ok: true, overrides }
}

export const AgentCmdOverridesUpdate = z
  .unknown()
  .superRefine((value, ctx) => {
    const parsed = parseAgentCmdOverrides(value)
    if (!parsed.ok) {
      ctx.addIssue({ code: 'custom', message: parsed.error })
    }
  })
  .transform((value) => {
    const parsed = parseAgentCmdOverrides(value)
    return parsed.ok ? parsed.overrides : {}
  })

export const GitHubProjectRef = z
  .object({
    owner: z.string(),
    ownerType: z.enum(['organization', 'user']),
    number: z.number().int(),
    host: z.string().optional()
  })
  .strict()

export const GitHubProjectSettings = z
  .object({
    pinned: z.array(GitHubProjectRef),
    recent: z.array(
      GitHubProjectRef.extend({
        lastOpenedAt: z.string()
      }).strict()
    ),
    lastViewByProject: z.record(z.string(), z.object({ viewId: z.string() }).strict()),
    activeProject: GitHubProjectRef.nullable()
  })
  .strict()

export const SettingsUpdate = z
  .object({
    machineName: z.string().trim().max(MACHINE_NAME_MAX_LENGTH).optional(),
    worktreeVisibilityDefaults: WorktreeVisibilityDefaultsUpdate.optional(),
    defaultTuiAgent: z
      .unknown()
      .transform((value) =>
        value === null || value === 'blank' || isTuiAgent(value) ? value : undefined
      )
      .optional(),
    disabledTuiAgents: z
      .unknown()
      .transform((value) => normalizeDisabledTuiAgents(value))
      .optional(),
    agentCmdOverrides: AgentCmdOverridesUpdate.optional(),
    agentDefaultArgs: z
      .unknown()
      .transform((value) => normalizeTuiAgentArgsRecord(value))
      .optional(),
    agentDefaultEnv: z
      .unknown()
      .transform((value) => normalizeTuiAgentEnvRecord(value))
      .optional(),
    defaultTaskSource: TaskProviderParam.optional(),
    visibleTaskProviders: z.array(TaskProviderParam).optional(),
    defaultTaskViewPreset: z
      .enum(['issues', 'my-issues', 'prs', 'my-prs', 'review', 'all'])
      .optional(),
    experimentalNewWorktreeCardStyle: z.boolean().optional(),
    agentStatusHooksEnabled: z.boolean().optional(),
    defaultRepoSelection: z.array(z.string()).nullable().optional(),
    defaultLinearTeamSelection: z.array(z.string()).nullable().optional(),
    compactWorktreeCards: z.boolean().optional(),
    minimaxGroupId: z.string().optional(),
    minimaxUsageModels: z.string().optional(),
    minimaxEndpoint: z.enum(['overseas', 'cn']).optional(),
    githubProjects: GitHubProjectSettings.optional(),
    prBotAuthorOverrides: z
      .unknown()
      .transform((value) => normalizePRBotAuthorOverrides(value))
      .optional()
  })
  .strict()
  .default({})
