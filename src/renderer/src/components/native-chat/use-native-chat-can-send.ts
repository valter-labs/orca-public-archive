import { useEffect, useMemo, useState } from 'react'
import { getDriverForPty, onDriverChange } from '@/lib/pane-manager/mobile-driver-state'
import { deriveNativeChatCanSend } from './native-chat-send-eligibility'
import { useAppStore } from '../../store'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import type { AgentType } from '../../../../shared/agent-status-types'
import { runtimeHostConnectionStateForEntry } from '@/runtime/runtime-host-connection-state'

/**
 * Track runtime availability and the mobile presence-lock for this chat pane's pty and derive the
 * composer's `canSend` (R8). The driver Map lives outside React for perf, so we
 * subscribe to its change events and re-read on each flip. A pty held by a
 * mobile client guards desktop sends exactly as it guards xterm input.
 */
export function useNativeChatCanSend(ptyId: string | null, agent: AgentType): boolean {
  const environmentId =
    ptyId && (agent === 'claude' || agent === 'codex')
      ? (parseRemoteRuntimePtyId(ptyId)?.environmentId ?? null)
      : null
  const runtimeReady = useAppStore((state) => {
    if (!environmentId) {
      return true
    }
    const entry = state.runtimeStatusByEnvironmentId.get(environmentId)
    // Why: mirrored PTYs survive reconnects; their continued presence does not prove input is writable.
    return (
      runtimeHostConnectionStateForEntry(entry) === 'connected' &&
      (!entry?.snapshot || entry.snapshot.transport === 'ready')
    )
  })
  const [driverTick, setDriverTick] = useState(0)
  // Why: the driver event fires for every pty; only re-derive when it targets
  // this pane's pty. ptyId is a dep so the listener re-binds on a pty swap.
  useEffect(
    () =>
      onDriverChange((event) => {
        if (event.ptyId !== ptyId) {
          return
        }
        setDriverTick((n) => n + 1)
      }),
    [ptyId]
  )
  return useMemo(() => {
    void driverTick
    return runtimeReady && deriveNativeChatCanSend(ptyId ? getDriverForPty(ptyId) : null)
  }, [ptyId, driverTick, runtimeReady])
}
