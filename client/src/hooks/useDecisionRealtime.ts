import { useEffect } from 'react'
import { addListener, removeListener, addReconnectListener, removeReconnectListener } from '../api/websocket'
import { decisionRepo } from '../repo/decisionRepo'
import { useDecisionStore } from '../store/decisionStore'

/**
 * Mounts the decision:* WebSocket listener for the open decision room.
 * Same pattern as the other dedicated listeners the registry-parity test
 * counts as HANDLED_OUTSIDE_TRIP_STORE: filter on the domain prefix, hand the
 * message to the store. The decision pages mount this once; anonymous
 * participants never connect (spec §9) so only the host side calls it.
 *
 * decision:* events broadcast while the socket is down are not replayed, so
 * on reconnect the room is re-pulled — the socket layer only rehydrates
 * tripStore on its own.
 */
export function useDecisionRealtime(): void {
  const applyEvent = useDecisionStore(s => s.applyEvent)

  useEffect(() => {
    const listener = (event: Record<string, unknown>) => {
      if (typeof event.type !== 'string' || !event.type.startsWith('decision:')) return
      applyEvent(event as Parameters<typeof applyEvent>[0])
    }
    const onReconnect = () => {
      const sessionId = useDecisionStore.getState().sessionId
      if (sessionId != null) void decisionRepo.open(sessionId)
    }
    addListener(listener)
    addReconnectListener(onReconnect)
    return () => {
      removeListener(listener)
      removeReconnectListener(onReconnect)
    }
  }, [applyEvent])
}
