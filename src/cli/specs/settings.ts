import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SETTINGS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['settings', 'get'],
    summary: 'Show agent launch settings without command or credential text',
    usage: 'orca settings get [--environment <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Prints defaultTuiAgent, disabledTuiAgents, agentStatusHooksEnabled, and which agents have a command override ({"configured": true}). Works against a paired Orca server with --environment.',
      'Command override text, agent arguments, and environment values are never printed, because they can embed credentials.'
    ],
    examples: ['orca settings get --json', 'orca settings get --environment <id> --json']
  },
  {
    path: ['settings', 'update'],
    summary: 'Apply agent command overrides from a JSON file',
    usage: 'orca settings update --file <path> [--environment <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'file'],
    notes: [
      'The file must be a regular file of at most 64 KiB holding a JSON object whose only key is agentCmdOverrides, mapping agent ids (for example claude, codex) to single-line launch commands.',
      'agentCmdOverrides replaces the whole saved map: agents left out lose their override, and an empty string clears one. Other settings are untouched.',
      'Unknown agent ids, unknown keys, non-string commands, and invalid JSON are rejected before anything is saved; errors never quote file content or key names.',
      'After saving, the command reads the settings back and fails if the saved overrides differ. Output lists only configuredAgents, never the commands. Orca servers that predate this setting reject the update.'
    ],
    examples: [
      'orca settings update --file ./agent-commands.json --json',
      'orca settings update --file ./agent-commands.json --environment <id> --json'
    ]
  }
]
