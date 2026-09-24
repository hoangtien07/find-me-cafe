import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User } from '../../types';
import type { DecisionSession } from '@trek/shared';
import { idParamSchema } from '@trek/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { DecisionService } from './decision.service';
import { NotFoundError, ValidationError } from '../common/domain-errors';
import { DecisionCreateDto, DecisionUpdateDto } from './decision.dto';

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
  constructor(private readonly decisions: DecisionService) {}

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

  /** GET /api/decisions/:id — the session, host only. */
  @Get(':id')
  get(@CurrentUser() user: User, @Param('id') id: string): { decision: DecisionSession } {
    const sessionId = idParamSchema.safeParse(id);
    if (!sessionId.success) throw new HttpException({ error: 'Invalid id' }, 400);
    const decision = this.decisions.getForHost(sessionId.data, user.id);
    if (!decision) throw new HttpException({ error: 'Decision not found' }, 404);
    return { decision };
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
}
