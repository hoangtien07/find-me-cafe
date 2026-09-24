import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { DecisionParticipant } from '@trek/shared';

/**
 * Resolves the anonymous participant attached by DecisionParticipantGuard.
 * Use on guarded handlers: `getThing(@CurrentParticipant() p: DecisionParticipant)`.
 */
export const CurrentParticipant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): DecisionParticipant | undefined => {
    return context.switchToHttp().getRequest().decisionParticipant;
  },
);
