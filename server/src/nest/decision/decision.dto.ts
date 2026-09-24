import { createZodDto } from 'nestjs-zod';
import {
  createDecisionRequestSchema,
  updateDecisionRequestSchema,
  createDecisionInviteRequestSchema,
  joinDecisionRequestSchema,
  updateParticipantContextRequestSchema,
  addDecisionCandidateRequestSchema,
  selectDecisionRequestSchema,
  createDecisionFeedbackRequestSchema,
  trackDecisionEventRequestSchema,
} from '@trek/shared';

/**
 * Server-side createZodDto wrappers over the @trek/shared decision contracts.
 * The global ZodValidationPipe (APP_PIPE in app.module.ts) validates any
 * @Body() parameter typed with one of these classes by metatype — the Zod
 * schemas in shared/ remain the single source of truth for the wire contract.
 */
export class DecisionCreateDto extends createZodDto(createDecisionRequestSchema) {}
export class DecisionUpdateDto extends createZodDto(updateDecisionRequestSchema) {}
export class DecisionInviteCreateDto extends createZodDto(createDecisionInviteRequestSchema) {}
export class DecisionJoinDto extends createZodDto(joinDecisionRequestSchema) {}
export class DecisionParticipantContextDto extends createZodDto(updateParticipantContextRequestSchema) {}
export class DecisionCandidateAddDto extends createZodDto(addDecisionCandidateRequestSchema) {}
export class DecisionSelectDto extends createZodDto(selectDecisionRequestSchema) {}
export class DecisionFeedbackDto extends createZodDto(createDecisionFeedbackRequestSchema) {}
export class DecisionTelemetryDto extends createZodDto(trackDecisionEventRequestSchema) {}
