import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User } from '../../types';
import type { DecisionCandidate, DecisionParticipantRosterEntry, DecisionSession, RecommendationResult } from '@trek/shared';
import { idParamSchema } from '@trek/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { DecisionService } from './decision.service';
import { DecisionResolverService } from './resolver/resolver.service';
import { DecisionTelemetryService } from './decision-telemetry.service';
import { NotFoundError, ValidationError } from '../common/domain-errors';
import {
  DecisionCreateDto,
  DecisionUpdateDto,
  DecisionInviteCreateDto,
  DecisionCandidateAddDto,
  DecisionSelectDto,
  DecisionFeedbackDto,
} from './decision.dto';
import type { DecisionInviteWithToken } from '@trek/shared';

/**
 * /api/decisions — the host-facing decision room ("chốt quán").
 *
 * A DecisionSession is a 1:1 overlay on a technical TREK trip: the trip is the
 * collaboration container (its room carries the decision:* WS broadcasts, its
 * places are the candidate venues) while the decision state lives in the
 * decision_* tables. Every route here is host-only: a stranger gets 404 so the
 * session id is never confirmed to exist for a non-owner.
 */
@Controller('api/decisions')
@UseGuards(JwtAuthGuard)
export class DecisionController {
  constructor(
    private readonly decisions: DecisionService,
    private readonly resolver: DecisionResolverService,
    private readonly telemetry: DecisionTelemetryService,
  ) {}

  /** POST /api/decisions — create a session + its technical trip container. */
  @Post()
  @HttpCode(201)
  create(@CurrentUser() user: User, @Body() body: DecisionCreateDto): { decision: DecisionSession } {
    const decision = this.decisions.create(user.id, body);
    return { decision };
  }

  /** GET /api/decisions — the sessions the caller hosts. */
  @Get()
  list(@CurrentUser() user: User): { decisions: DecisionSession[] } {
    return { decisions: this.decisions.list(user.id) };
  }

  /**
   * GET /api/decisions/:id — the session plus the host's participant roster.
   * The roster is names + submitted flags only; individual contexts stay
   * private to each participant's scoped token.
   */
  @Get(':id')
  get(@CurrentUser() user: User, @Param('id') id: string): { decision: DecisionSession; participants: DecisionParticipantRosterEntry[] } {
    const sessionId = idParamSchema.safeParse(id);
    if (!sessionId.success) throw new HttpException({ error: 'Invalid id' }, 400);
    const decision = this.decisions.getForHost(sessionId.data, user.id);
    if (!decision) throw new HttpException({ error: 'Decision not found' }, 404);
    return { decision, participants: this.decisions.listRoster(sessionId.data) };
  }

  /** PATCH /api/decisions/:id — mutable fields + host-driven lifecycle moves. */
  @Patch(':id')
  @HttpCode(200)
  update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: DecisionUpdateDto,
  ): { decision: DecisionSession } {
    const sessionId = idParamSchema.safeParse(id);
    if (!sessionId.success) throw new HttpException({ error: 'Invalid id' }, 400);
    if (!this.decisions.getForHost(sessionId.data, user.id)) {
      throw new HttpException({ error: 'Decision not found' }, 404);
    }
    try {
      return { decision: this.decisions.update(sessionId.data, body) };
    } catch (e: unknown) {
      if (e instanceof ValidationError) throw new HttpException({ error: e.message }, 400);
      if (e instanceof NotFoundError) throw new HttpException({ error: e.message }, 404);
      throw e;
    }
  }

  /**
   * POST /api/decisions/:id/invites — mint an anonymous join link. The
   * plaintext token is returned here and only here; the DB keeps its SHA-256.
   */
  @Post(':id/invites')
  @HttpCode(201)
  createInvite(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: DecisionInviteCreateDto,
  ): { invite: DecisionInviteWithToken } {
    const sessionId = idParamSchema.safeParse(id);
    if (!sessionId.success) throw new HttpException({ error: 'Invalid id' }, 400);
    if (!this.decisions.getForHost(sessionId.data, user.id)) {
      throw new HttpException({ error: 'Decision not found' }, 404);
    }
    const invite = this.decisions.createInvite(sessionId.data, user.id, body.expires_in_days);
    return { invite };
  }

  /** GET /api/decisions/:id/candidates — the pinned candidate venues. */
  @Get(':id/candidates')
  listCandidates(@CurrentUser() user: User, @Param('id') id: string): { candidates: DecisionCandidate[] } {
    const sessionId = this.requireHostedSession(user, id);
    return { candidates: this.decisions.listCandidates(sessionId) };
  }

  /** POST /api/decisions/:id/candidates — pin a trip Place as a candidate. */
  @Post(':id/candidates')
  @HttpCode(201)
  addCandidate(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: DecisionCandidateAddDto,
  ): { candidate: DecisionCandidate } {
    const sessionId = this.requireHostedSession(user, id);
    try {
      return { candidate: this.decisions.addCandidate(sessionId, body.place_id, { type: 'host', id: user.id }) };
    } catch (e: unknown) {
      this.throwMapped(e);
    }
  }

  /** DELETE /api/decisions/:id/candidates/:candidateId — unpin a candidate. */
  @Delete(':id/candidates/:candidateId')
  @HttpCode(200)
  removeCandidate(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Param('candidateId') candidateId: string,
  ): { ok: true } {
    const sessionId = this.requireHostedSession(user, id);
    const cid = idParamSchema.safeParse(candidateId);
    if (!cid.success) throw new HttpException({ error: 'Invalid candidate id' }, 400);
    try {
      this.decisions.removeCandidate(sessionId, cid.data);
    } catch (e: unknown) {
      this.throwMapped(e);
    }
    return { ok: true };
  }

  /**
   * POST /api/decisions/:id/resolve — run resolver-v1: constraints → matrix →
   * fairness → ranking → persist run + scores → 'resolved' → broadcast
   * decision:recommendation-ready (content-free; clients refetch).
   */
  @Post(':id/resolve')
  @HttpCode(200)
  async resolve(@CurrentUser() user: User, @Param('id') id: string): Promise<RecommendationResult> {
    const sessionId = this.requireHostedSession(user, id);
    try {
      return await this.resolver.resolve(sessionId);
    } catch (e: unknown) {
      this.throwMapped(e);
    }
  }

  /** GET /api/decisions/:id/recommendations/latest — the latest completed run. */
  @Get(':id/recommendations/latest')
  latest(@CurrentUser() user: User, @Param('id') id: string): RecommendationResult {
    const sessionId = this.requireHostedSession(user, id);
    const result = this.resolver.latestResult(sessionId);
    if (!result) throw new HttpException({ error: 'No completed run' }, 404);
    this.telemetry.track(sessionId, 'recommendation_viewed', { userId: user.id });
    return result;
  }

  /**
   * POST /api/decisions/:id/select — the host locks in the group's venue.
   * Replaces any prior selection; requires status resolved/selected.
   */
  @Post(':id/select')
  @HttpCode(200)
  select(@CurrentUser() user: User, @Param('id') id: string, @Body() body: DecisionSelectDto) {
    const sessionId = this.requireHostedSession(user, id);
    try {
      return { selection: this.decisions.select(sessionId, body.candidate_id, user.id) };
    } catch (e: unknown) {
      this.throwMapped(e);
    }
  }

  /** POST /api/decisions/:id/feedback — the host's own post-outing feedback. */
  @Post(':id/feedback')
  @HttpCode(201)
  addFeedback(@CurrentUser() user: User, @Param('id') id: string, @Body() body: DecisionFeedbackDto) {
    const sessionId = this.requireHostedSession(user, id);
    try {
      return { feedback: this.decisions.addFeedback(sessionId, body, null) };
    } catch (e: unknown) {
      this.throwMapped(e);
    }
  }

  /** The session id when `id` parses and `user` hosts it; the shared 400/404. */
  private requireHostedSession(user: User, id: string): number {
    const sessionId = idParamSchema.safeParse(id);
    if (!sessionId.success) throw new HttpException({ error: 'Invalid id' }, 400);
    if (!this.decisions.getForHost(sessionId.data, user.id)) {
      throw new HttpException({ error: 'Decision not found' }, 404);
    }
    return sessionId.data;
  }

  /** Map the domain errors onto HTTP. Always throws. */
  private throwMapped(e: unknown): never {
    if (e instanceof ValidationError) throw new HttpException({ error: e.message }, 400);
    if (e instanceof NotFoundError) throw new HttpException({ error: e.message }, 404);
    throw e;
  }
}
