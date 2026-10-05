import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_SEND_COMMAND_SPEC: CommandSpec = {
  path: ['terminal', 'send'],
  summary: 'Send input to a live terminal',
  usage:
    'orca terminal send [--terminal <handle>] [--text <text> | --text-stdin] [--enter] [--interrupt] [--wait-submit <seconds>] [--retry-request <id>] [--json]',
  allowedFlags: [
    ...GLOBAL_FLAGS,
    'terminal',
    'text',
    'text-stdin',
    'enter',
    'interrupt',
    'wait-submit',
    'retry-request'
  ],
  notes: [
    'For a text-plus-Enter agent prompt, the result separates input acceptance from observed submission and turn start.',
    '--wait-submit only observes the accepted prompt for the requested duration; timeout returns the queued/input-accepted receipt and never resends.',
    'After an ambiguous transport failure, reissue the exact command with the reported --retry-request ID. The ID is bound to the prompt payload and exact terminal process incarnation.',
    'Older hosts accept the legacy raw input but report provider old-host and do not offer idempotent retry or submission observation.',
    '--text-stdin reads the text from piped stdin instead of argv, keeping private prompts out of shell history and process listings. It is sent exactly as read (a trailing newline included), must be non-empty valid UTF-8 of at most 64 KiB, may contain only tab and newline control characters, and cannot be combined with --text.'
  ],
  examples: [
    'orca terminal send --terminal term_abc123 --text "hi" --enter --json',
    'printf \'%s\' "$PROMPT" | orca terminal send --terminal term_abc123 --text-stdin --enter --json'
  ]
}
