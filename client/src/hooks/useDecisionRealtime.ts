import { useEffect } from 'react'
import { addListener, removeListener } from '../api/websocket'
import { useDecisionStore } from '../store/decisionStore'

/**
 * Mounts the decision:* WebSocket listener for the open decision room.
 * Same pattern as the other dedicated listeners the registry-parity test
 * counts as HANDLED_OUTSIDE_TRIP_STORE: filter on the domain prefix, hand the
 * message to the store. The decision pages mount this once; anonymous
 * participants never connect (spec §9) so only the host side calls it.
 */
export function useDecisionRealtime(): void {
  const applyEvent = useDecisionStore(s => s.applyEvent)

  useEffect(() => {
    const listener = (event: Record<string, unknown>) => {
      if (typeof event.type !== 'string' || !event.type.startsWith('decision:')) return
      applyEvent(event as Parameters<typeof applyEvent>[0])
    }
    addListener(listener)
    return () => removeListener(listener)
  }, [applyEvent])
}
