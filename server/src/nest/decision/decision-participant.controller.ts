import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { DecisionCandidate, DecisionParticipant, DecisionParticipantSessionResponse, DecisionVoteTally, RecommendationResult } from '@trek/shared';
import { DecisionService } from './decision.service';
import { DecisionResolverService } from './resolver/resolver.service';
import { DecisionTelemetryService } from './decision-telemetry.service';
import { DecisionParticipantGuard } from './decision-participant.guard';
import { CurrentParticipant } from './current-participant.decorator';
import { DecisionParticipantContextDto, DecisionTelemetryDto, DecisionVoteDto } from './decision.dto';

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
  constructor(
    private readonly decisions: DecisionService,
    private readonly resolver: DecisionResolverService,
    private readonly telemetry: DecisionTelemetryService,
  ) {}

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

  /** GET /api/decision-participant/candidates — the venues the group is choosing between. */
  @Get('candidates')
  candidates(@CurrentParticipant() p: DecisionParticipant): { candidates: DecisionCandidate[] } {
    return { candidates: this.decisions.listCandidates(p.decision_session_id) };
  }

  /** GET /api/decision-participant/result — the latest recommendation for their room. */
  @Get('result')
  result(@CurrentParticipant() p: DecisionParticipant): RecommendationResult {
    const result = this.resolver.latestResult(p.decision_session_id);
    if (!result) throw new HttpException({ error: 'No completed run' }, 404);
    return result;
  }

  /**
   * POST /api/decision-participant/telemetry — let a participant self-report a
   * client-side funnel step (navigation_opened / recommendation_viewed). The
   * enum whitelist keeps devices from minting server-side funnel events.
   */
  @Post('telemetry')
  @HttpCode(200)
  track(@CurrentParticipant() p: DecisionParticipant, @Body() body: DecisionTelemetryDto): { ok: boolean } {
    this.telemetry.track(p.decision_session_id, body.event, { participantId: p.id });
    return { ok: true };
  }

  /**
   * PUT /api/decision-participant/vote — the optional final vote (M2-10):
   * socially confirm one of the recommended venues. Re-casting changes the
   * vote; the host's trip room hears the new tally live.
   */
  @Put('vote')
  @HttpCode(200)
  vote(@CurrentParticipant() p: DecisionParticipant, @Body() body: DecisionVoteDto): DecisionVoteTally {
    return this.decisions.castVote(p.decision_session_id, p.id, Number(body.candidate_id));
  }

  /** GET /api/decision-participant/votes — the group's tally so far (M2-10). */
  @Get('votes')
  votes(@CurrentParticipant() p: DecisionParticipant): DecisionVoteTally {
    return this.decisions.voteTally(p.decision_session_id);
  }
}
