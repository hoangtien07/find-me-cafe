import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { DecisionService } from './decision.service';
import { DecisionJoinDto } from './decision.dto';
import type { DecisionInvitePreview, DecisionJoinResponse } from '@trek/shared';

/**
 * /api/decision-invites — the anonymous edge of the decision room.
 *
 * A stranger opens the invite URL, previews the outing (title/occasion/count —
 * never who is inside), then joins with a display name. The token in the path
 * is the only credential; the server stores its SHA-256 hash. Joining mints a
 * `decision_participants` row plus a scoped participant session (its own
 * hashed token — never a TREK user, never the global JWT), per spec §8.
 */
@Public('the invite token in the path is the only credential — a stranger has no TREK session')
@Controller('api/decision-invites')
export class DecisionInviteController {
  constructor(private readonly decisions: DecisionService) {}

  /** GET /api/decision-invites/:token — minimal public preview before joining. */
  @Get(':token')
  preview(@Param('token') token: string): { invite: DecisionInvitePreview } {
    const invite = this.decisions.previewInvite(token);
    if (!invite) throw new HttpException({ error: 'Invite not found' }, 404);
    return { invite };
  }

  /**
   * POST /api/decision-invites/:token/join — create the participant + scoped
   * token. The plaintext participant token is returned here and only here.
   */
  @Post(':token/join')
  @HttpCode(201)
  join(@Param('token') token: string, @Body() body: DecisionJoinDto): { participant: DecisionJoinResponse['participant']; participant_token: string } {
    const joined = this.decisions.joinByInvite(token, body.display_name, body.context);
    if (!joined) throw new HttpException({ error: 'Invite not found or no longer joinable' }, 404);
    return joined;
  }
}
