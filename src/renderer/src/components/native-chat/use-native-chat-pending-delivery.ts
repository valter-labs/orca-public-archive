import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  recoverNativeChatReliableDelivery,
  type NativeChatReliableDelivery
} from './native-chat-reliable-send'
import { translate } from '@/i18n/i18n'
import type { AgentType, NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  appendPendingSendCache,
  nextNativeChatPendingSendId,
  pendingSendsAsMessages,
  prunePendingSends,
  readPendingSendCache,
  subscribePendingSendCache,
  writePendingSendCache,
  type NativeChatPendingSend
} from './native-chat-pending'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'

/** How long a send whose write acknowledgment was lost waits for its row; the phone's hold matches. */
export const NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS = 20_000

const NO_NOTICES: ReadonlyMap<string, NativeChatDeliveryNotice> = new Map()

/** Optimistic terminal-Chat echoes plus the definite send outcomes the transport reports. */
export function useNativeChatPendingDelivery(args: {
  paneKey: string
  agent: AgentType
  messages: NativeChatMessage[]
}) {
  const { paneKey, agent, messages } = args
  const scope = useMemo(() => ({ paneKey, agent }), [paneKey, agent])
  const [pending, setPending] = useState(() => readPendingSendCache(scope))
  useEffect(() => {
    setPending(readPendingSendCache(scope))
    // Why: a started send can finish through callbacks owned by an unmounted composer.
    return subscribePendingSendCache(scope, () => setPending(readPendingSendCache(scope)))
  }, [scope])
  const save = useCallback(
    (update: (entries: NativeChatPendingSend[]) => NativeChatPendingSend[]) => {
      const current = readPendingSendCache(scope)
      const next = update(current)
      // Why: pruning runs on every stream update; a no-op must not re-render the list.
      if (next !== current) {
        setPending(writePendingSendCache(scope, next))
      }
    },
    [scope]
  )
  useEffect(() => {
    save((entries) => prunePendingSends(entries, messages))
  }, [messages, save])
  const record = useCallback(
    (text: string, imagePaths?: string[]) => {
      const sentAt = Date.now()
      const boundary = messages.at(-1)
      const entry: NativeChatPendingSend = {
        id: nextNativeChatPendingSendId(sentAt),
        text,
        sentAt,
        afterMessageId: boundary?.id ?? null,
        afterMessageTimestamp: boundary?.timestamp ?? null,
        ...(imagePaths ? { imagePaths } : {})
      }
      setPending(appendPendingSendCache(scope, entry))
      return entry.id
    },
    [messages, scope]
  )
  const cancel = useCallback(
    (id: string) => save((entries) => entries.filter((entry) => entry.id !== id)),
    [save]
  )
  const reject = useCallback(
    (id: string) =>
      save((entries) =>
        entries.map((entry) => (entry.id === id ? { ...entry, delivery: 'rejected' } : entry))
      ),
    [save]
  )
  const beginReliable = useCallback(
    (id: string, binding: NativeChatReliableDelivery) =>
      save((entries) =>
        entries.map((entry) => (entry.id === id ? { ...entry, reliableDelivery: binding } : entry))
      ),
    [save]
  )
  const received = useCallback(
    (id: string, binding: NativeChatReliableDelivery) =>
      save((entries) =>
        entries.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                reliableDelivery: binding,
                reliableReceiptAccepted: true,
                delivery: undefined,
                writeUnconfirmedAt: undefined
              }
            : entry
        )
      ),
    [save]
  )
  useEffect(() => {
    const recovering = new Set<string>()
    const recover = () => {
      for (const entry of readPendingSendCache(scope)) {
        if (
          !entry.reliableDelivery ||
          entry.reliableReceiptAccepted ||
          entry.delivery === 'rejected' ||
          recovering.has(entry.id)
        ) {
          continue
        }
        recovering.add(entry.id)
        // Why: a reconnect can read the original receipt but must never issue terminal.send again.
        void recoverNativeChatReliableDelivery(entry.reliableDelivery)
          .then((receipt) => {
            if (receipt?.rejected) {
              reject(entry.id)
            } else if (receipt && !receipt.rejected) {
              received(entry.id, receipt.binding)
            }
          })
          .catch(() => {})
          .finally(() => recovering.delete(entry.id))
      }
    }
    recover()
    return window.api?.runtimeEnvironments?.onStatusChanged?.((snapshot) => {
      if (snapshot.verification === 'verified') {
        recover()
      }
    })
  }, [scope, received, reject])
  const holdUnconfirmed = useCallback(
    (id: string) =>
      save((entries) =>
        entries.map((entry) =>
          entry.id === id && !entry.delivery && entry.writeUnconfirmedAt === undefined
            ? {
                ...entry,
                writeUnconfirmedAt: Date.now(),
                ...(entry.reliableDelivery ? { delivery: 'unconfirmed' as const } : {})
              }
            : entry
        )
      ),
    [save]
  )
  // Why keep outcomes: Stop cannot affect a settled failure, and its bubble holds the only copy.
  const clear = useCallback(
    () => save((entries) => entries.filter((entry) => entry.delivery || entry.reliableDelivery)),
    [save]
  )

  // A lost acknowledgment is the only unconfirmed trigger: an ordinary send, including one Claude
  // queues mid-turn, has no transport doubt and stays pending until its row lands.
  const nextHoldDeadline = useMemo(() => {
    const deadlines = pending.flatMap((entry) =>
      entry.writeUnconfirmedAt !== undefined && !entry.delivery
        ? [entry.writeUnconfirmedAt + NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS]
        : []
    )
    return deadlines.length > 0 ? Math.min(...deadlines) : null
  }, [pending])
  useEffect(() => {
    if (nextHoldDeadline === null) {
      return
    }
    const timer = setTimeout(
      () => {
        const now = Date.now()
        save((entries) => {
          const due = entries.filter(
            (entry) =>
              entry.writeUnconfirmedAt !== undefined &&
              !entry.delivery &&
              entry.writeUnconfirmedAt + NATIVE_CHAT_UNCONFIRMED_SEND_HOLD_MS <= now
          )
          if (due.length === 0) {
            return entries
          }
          const unmatched = new Set(
            pendingSendsAsMessages(due, messages).map((message) => message.id)
          )
          if (unmatched.size === 0) {
            return entries
          }
          return entries.map((entry) =>
            due.includes(entry) && unmatched.has(`pending:${entry.id}`)
              ? { ...entry, delivery: 'unconfirmed' as const }
              : entry
          )
        })
      },
      Math.max(0, nextHoldDeadline - Date.now())
    )
    return () => clearTimeout(timer)
  }, [nextHoldDeadline, messages, save])

  const notices = useMemo(() => {
    if (!pending.some((entry) => entry.delivery || entry.reliableReceiptAccepted)) {
      return NO_NOTICES
    }
    const result = new Map<string, NativeChatDeliveryNotice>()
    for (const entry of pending) {
      if (!entry.delivery && !entry.reliableReceiptAccepted) {
        continue
      }
      result.set(`pending:${entry.id}`, {
        text: entry.reliableReceiptAccepted
          ? translate(
              'components.native-chat.receivedByServer',
              'Received by server — waiting for the conversation'
            )
          : entry.delivery === 'rejected'
            ? translate('components.native-chat.messageNotSent', 'Message not sent')
            : translate(
                'components.native-chat.deliveryUnconfirmed',
                'Delivery unconfirmed — check chat before retrying'
              ),
        onDismiss: () => cancel(entry.id)
      })
    }
    return result
  }, [pending, cancel])
  return {
    pending,
    record,
    cancel,
    reject,
    holdUnconfirmed,
    beginReliable,
    received,
    clear,
    notices
  }
}
