// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission } from './orca-runtime-resolve-authoritative-terminal-wait-permission'
import type { RuntimeAgentPromptWriteOptions } from './runtime-terminal-contracts'
import type { RuntimeTerminalPromptDelivery, RuntimeTerminalSend } from '../../shared/runtime-types'
import {
  assertAgentPromptRequestActive,
  waitForAgentPromptDelay,
  waitForAgentPromptPromise
} from './orca-runtime-core'
import {
  AGENT_PROMPT_SUBMIT,
  agentPromptSubmitJoinsPasteFrame,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs,
  resolveAgentPromptSubmitDelayForAgent
} from '../../shared/agent-prompt-injection'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../shared/agent-tui-input-clear'
import { AGENT_TUI_COMMAND_KEY_INTERVAL_MS } from '../../shared/agent-tui-command-typing'
import type { AgentPromptWaitTextCache } from './agent-prompt-submission-verification'
import {
  isTerminalSendSettlementAgent,
  resolveAgentPromptEffectTimeoutMs,
  verifyAgentPromptSubmission
} from './agent-prompt-submission-verification'

export class OrcaRuntimeWithWriteTerminalAgentPrompt extends OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission {
  protected async writeTerminalAgentPrompt(
    handle: string,
    ptyId: string,
    generation: number,
    pastePayload: string,
    options: RuntimeAgentPromptWriteOptions
  ): Promise<{ submits: number; prompt?: RuntimeTerminalPromptDelivery }> {
    assertAgentPromptRequestActive(options.signal)
    this.assertAgentPromptGeneration(ptyId, generation)
    const permissionBaseline = this.getAgentPromptActivity(handle, ptyId)
    this.assertAgentPromptPermissionSafe(permissionBaseline, permissionBaseline)
    const writeHostPlatform = this.getPtyWriteHostPlatform(ptyId)
    const pty = this.ptysById.get(ptyId)
    // Why: later foreground refreshes must not redirect the delayed Enter to a different agent.
    const expectedAgent = pty?.foregroundAgent ?? pty?.launchAgent
    // OMP treats a large bracketed paste as a menu unless submit arrives in the same PTY write.
    // Once a foreground agent is known, it is the process that will consume the bytes;
    // launchAgent is only the fallback during startup before process detection settles.
    const submitWithPaste = agentPromptSubmitJoinsPasteFrame(expectedAgent)
    const pasteByteLength = Buffer.byteLength(pastePayload, 'utf8')
    const pasteIngestMs = getTerminalPasteIngestMs(writeHostPlatform, pasteByteLength)
    let renderGate: ReturnType<typeof this.createAgentPromptRenderGate> = null
    // Why: disconnect after durable input starts must not strand the body without Enter.
    const submitSignal = options.acceptQueued && options.requestId ? undefined : options.signal
    const waitTextCache: AgentPromptWaitTextCache = {}
    const preSubmitBaseline = submitWithPaste
      ? this.getAgentPromptActivity(handle, ptyId, waitTextCache)
      : undefined
    try {
      assertAgentPromptRequestActive(options.signal)
      this.assertAgentPromptGeneration(ptyId, generation)
      if (options.clearUnsubmittedInput) {
        await this.assertChatPromptForegroundAgent(ptyId, expectedAgent)
      }
      await options.beforeWrite?.(ptyId)
      assertAgentPromptRequestActive(options.signal)
      this.assertAgentPromptGeneration(ptyId, generation)
      this.assertAgentPromptPermissionSafe(
        permissionBaseline,
        this.getAgentPromptActivity(handle, ptyId)
      )
      if (options.clearUnsubmittedInput) {
        if (expectedAgent === 'claude') {
          // Why: batched clears leave Claude 2.1.291's next prompt unsubmitted; per-key clears do not.
          // Keep controls as keystrokes until Claude accepts the full clear burst as key events.
          for (const [index, key] of [...AGENT_TUI_CLEAR_INPUT_MAX].entries()) {
            if (index > 0) {
              await this.assertChatPromptForegroundAgent(ptyId, expectedAgent, true)
              await options.beforeWrite?.(ptyId)
              assertAgentPromptRequestActive(submitSignal)
              this.assertAgentPromptGeneration(ptyId, generation)
              this.assertAgentPromptPermissionSafe(
                permissionBaseline,
                this.getAgentPromptActivity(handle, ptyId)
              )
            }
            if (!this.ptyController?.write(ptyId, key, options.inputKind)) {
              throw new Error('terminal_not_writable')
            }
            if (index < AGENT_TUI_CLEAR_INPUT_MAX.length - 1) {
              await waitForAgentPromptDelay(AGENT_TUI_COMMAND_KEY_INTERVAL_MS, submitSignal)
            }
          }
          await this.assertChatPromptForegroundAgent(ptyId, expectedAgent, true)
          await options.beforeWrite?.(ptyId)
          assertAgentPromptRequestActive(submitSignal)
          this.assertAgentPromptGeneration(ptyId, generation)
          this.assertAgentPromptPermissionSafe(
            permissionBaseline,
            this.getAgentPromptActivity(handle, ptyId)
          )
        } else if (
          !this.ptyController?.write(ptyId, AGENT_TUI_CLEAR_INPUT_MAX, options.inputKind)
        ) {
          throw new Error('terminal_not_writable')
        }
      }
      // Keep the bracketed paste frame in one PTY write; Claude's composer can drop the
      // beginning when a large frame is split into independently processed chunks.
      renderGate = this.createAgentPromptRenderGate(ptyId, pasteIngestMs)
      renderGate?.arm()
      const initialWrite = submitWithPaste ? pastePayload + AGENT_PROMPT_SUBMIT : pastePayload
      if (!this.ptyController?.write(ptyId, initialWrite, options.inputKind)) {
        throw new Error('terminal_not_writable')
      }
    } catch (error) {
      renderGate?.dispose()
      throw error
    }

    if (submitWithPaste) {
      // The Enter was part of the paste frame; waiting here would only delay receipt settlement.
      renderGate?.dispose()
    } else if (renderGate) {
      try {
        await waitForAgentPromptPromise(renderGate.wait(), submitSignal)
      } finally {
        renderGate.dispose()
      }
    } else {
      const agent = this.getPtyAgent(ptyId)
      const submitDelayMs = options.promptForSchedule
        ? resolveAgentPromptSubmitDelayForAgent(writeHostPlatform, options.promptForSchedule, agent)
        : getAgentPromptSubmitDelayMs(writeHostPlatform, pasteByteLength)
      await waitForAgentPromptDelay(submitDelayMs, submitSignal)
    }
    assertAgentPromptRequestActive(submitSignal)
    this.assertAgentPromptGeneration(ptyId, generation)
    if (!submitWithPaste) {
      try {
        if (options.clearUnsubmittedInput) {
          await this.assertChatPromptForegroundAgent(ptyId, expectedAgent, true)
        }
        await options.beforeWrite?.(ptyId)
      } catch (error) {
        if (options.suffixFailureError) {
          throw new Error(options.suffixFailureError)
        }
        throw error
      }
      assertAgentPromptRequestActive(submitSignal)
      this.assertAgentPromptGeneration(ptyId, generation)
    }
    const baseline = preSubmitBaseline ?? this.getAgentPromptActivity(handle, ptyId, waitTextCache)
    this.assertAgentPromptPermissionSafe(permissionBaseline, baseline)
    if (!submitWithPaste) {
      if (!this.ptyController?.write(ptyId, AGENT_PROMPT_SUBMIT, options.inputKind)) {
        throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
      }
    }
    const effectTimeoutMs = resolveAgentPromptEffectTimeoutMs(this.getPtyAgent(ptyId))
    if (!options.acceptQueued || !options.requestId) {
      await verifyAgentPromptSubmission({
        baseline,
        readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
        timeoutMs: effectTimeoutMs,
        signal: options.signal
      })
      return { submits: 1 }
    }
    const binding = this.getTerminalPromptRequestBinding(handle)
    const foregroundAgent = this.ptysById.get(ptyId)?.foregroundAgent
    const launchAgent = this.ptysById.get(ptyId)?.launchAgent
    const settlementAgent = isTerminalSendSettlementAgent(foregroundAgent)
      ? foregroundAgent
      : isTerminalSendSettlementAgent(launchAgent)
        ? launchAgent
        : null
    const inputAccepted: RuntimeTerminalPromptDelivery = {
      requestId: options.requestId,
      stages: ['input_accepted'],
      provider: settlementAgent ?? 'unsupported',
      observation: settlementAgent ? 'supported' : 'unsupported',
      processIncarnation: binding.processIncarnation,
      generation,
      baselineWorkingSequence: baseline.workingSequence,
      baselineExplicitWorkingStartedAt: baseline.explicitWorkingStartedAt,
      baselinePermissionSequence: baseline.permissionSequence
    }
    const checkpoint: RuntimeTerminalSend = {
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(pastePayload, 'utf8') + 1,
      prompt: inputAccepted
    }
    options.onInputAccepted?.(checkpoint)
    // Providers without a lifecycle verifier still get an honest accepted
    // receipt; they must not fail a Dispatch merely because Orca cannot prove
    // submission through hooks.
    if (!settlementAgent) {
      return { submits: 1, prompt: inputAccepted }
    }
    this.registerAgentPromptRequest(
      ptyId,
      generation,
      options.requestId,
      baseline.workingSequence,
      baseline.explicitWorkingStartedAt
    )
    try {
      await verifyAgentPromptSubmission({
        baseline,
        readActivity: () => this.getAgentPromptActivity(handle, ptyId, waitTextCache),
        acceptTurnStart: (evidence) =>
          this.acceptAgentPromptTurnStart(
            ptyId,
            generation,
            options.requestId!,
            baseline.workingSequence,
            baseline.explicitWorkingStartedAt,
            evidence
          ),
        allowOutputEvidence: false,
        signal: options.signal,
        timeoutMs: options.observationTimeoutMs ?? effectTimeoutMs
      })
      this.forgetAgentPromptRequest(ptyId, generation, options.requestId)
      return {
        submits: 1,
        prompt: {
          ...inputAccepted,
          stages: ['input_accepted', 'turn_started']
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'agent_prompt_stalled') {
        return { submits: 1, prompt: inputAccepted }
      }
      if (error instanceof Error && error.message === 'agent_prompt_blocked') {
        this.forgetAgentPromptRequest(ptyId, generation, options.requestId)
        return {
          submits: 1,
          prompt: { ...inputAccepted, observation: 'permission' }
        }
      }
      throw error
    }
  }
  private async assertChatPromptForegroundAgent(
    ptyId: string,
    expectedAgent: string | null | undefined,
    inputStarted = false
  ): Promise<void> {
    // Why: an agent can exit while a queued send or its delayed Enter waits without replacing the PTY.
    const foreground = this.ptyController?.confirmForegroundProcess
      ? await this.ptyController.confirmForegroundProcess(ptyId)
      : await this.ptyController?.getForegroundProcess(ptyId)
    const agent = recognizeAgentProcess(foreground)?.agent
    if ((agent !== 'claude' && agent !== 'codex') || agent !== expectedAgent) {
      throw new Error(inputStarted ? 'agent_prompt_target_changed' : 'terminal_guard_no_agent')
    }
  }
}
