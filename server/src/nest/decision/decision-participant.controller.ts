import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { DecisionParticipant, DecisionParticipantSessionResponse } from '@trek/shared';
import { DecisionService } from './decision.service';
import { DecisionParticipantGuard } from './decision-participant.guard';
import { CurrentParticipant } from './current-participant.decorator';
import { DecisionParticipantContextDto } from './decision.dto';

/**
 * /api/decision-participant — the anonymous participant's scoped surface.
 *
 * Every route sits behind DecisionParticipantGuard: the bearer token minted at
 * join resolves exactly one participant row, and every read/write is scoped to
 * it — a participant can never reach another room or another participant's
 * data. Participants hold no WebSocket in V1; their writes broadcast on the
 * host's trip room instead (spec §9).
 */
@UseGuards(DecisionParticipantGuard)
@Controller('api/decision-participant')
export class DecisionParticipantController {
  constructor(private readonly decisions: DecisionService) {}

  /** GET /api/decision-participant/session — the room, the roster, own context. */
  @Get('session')
  session(@CurrentParticipant() p: DecisionParticipant): DecisionParticipantSessionResponse {
    const view = this.decisions.participantSessionView(p.id);
    if (!view) throw new HttpException({ error: 'Participant not found' }, 404);
    return view;
  }

  /**
   * PUT /api/decision-participant/context — the intake: origin, travel cap,
   * budget, preferences, deal-breakers. Stamps submitted_at and broadcasts
   * decision:participant-updated on the host's trip room.
   */
  @Put('context')
  @HttpCode(200)
  context(
    @CurrentParticipant() p: DecisionParticipant,
    @Body() body: DecisionParticipantContextDto,
  ): { participant: DecisionParticipant } {
    return { participant: this.decisions.updateParticipantContext(p.id, p.decision_session_id, body) };
  }
}
