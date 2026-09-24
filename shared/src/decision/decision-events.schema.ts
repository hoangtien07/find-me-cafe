import { idSchema } from '../common/primitives.schema';
import {
  decisionCandidateSchema,
  decisionParticipantSchema,
  decisionSelectionSchema,
  decisionStatusSchema,
} from './decision.schema';

import { z } from 'zod';

/**
 * Decision WS payload contracts — the registry entries in
 * realtime/events.schema.ts reference these. All seven are trip-scoped:
 * they broadcast on the technical trip's room, which only the authenticated
 * host's sockets can join (anonymous participants never hold a socket in V1 —
 * spec §9). Payloads carry the wire entity shapes, not raw DB rows, so a
 * `participant` here is the Zod-typed API row, not `z.unknown()` scaffolding.
 */
const id = z.union([z.number(), z.string()]);

export const decisionWsEventPayloads = {
  /** A participant row as it exists after join or after a context submit. */
  'decision:participant-joined': z.object({ participant: decisionParticipantSchema }),
  'decision:participant-updated': z.object({ participant: decisionParticipantSchema }),
  'decision:candidate-added': z.object({ candidate: decisionCandidateSchema }),
  'decision:candidate-removed': z.object({ decisionSessionId: id, candidateId: id }),
  'decision:status-updated': z.object({ decisionSessionId: id, status: decisionStatusSchema }),
  /**
   * Content-free on purpose: the host refetches recommendations/latest rather
   * than trusting a payload the size of a run to every connected client.
   */
  'decision:recommendation-ready': z.object({ decisionSessionId: id, runId: idSchema }),
  'decision:selected': z.object({ decisionSessionId: id, selection: decisionSelectionSchema }),
} as const;

export const DECISION_WS_EVENT_NAMES = Object.keys(
  decisionWsEventPayloads,
) as readonly (keyof typeof decisionWsEventPayloads)[];
