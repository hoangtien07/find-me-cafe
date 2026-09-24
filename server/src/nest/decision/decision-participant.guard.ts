import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { DecisionService } from './decision.service';

/**
 * Authenticates an anonymous decision participant by its scoped bearer token.
 *
 * The credential is issued by POST /api/decision-invites/:token/join and is a
 * `decision_participant_sessions` row — never a TREK user, never the global
 * JWT surface. Like ApiTokenGuard the lookup hashes the presented token with
 * SHA-256 and matches the hash; a revoked or expired session is
 * indistinguishable from one that does not exist.
 *
 * Resolves `req.decisionParticipant` — the participant row the rest of the
 * handler scopes every read and write to.
 */
@Injectable()
export class DecisionParticipantGuard implements CanActivate {
  constructor(private readonly decisions: DecisionService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const token = extractBearerToken(req);
    if (!token) {
      throw new HttpException(
        { error: 'Participant token required', code: 'PARTICIPANT_TOKEN_REQUIRED' },
        401,
      );
    }
    const participant = this.decisions.findParticipantByToken(token);
    if (!participant) {
      throw new HttpException(
        { error: 'Invalid participant token', code: 'PARTICIPANT_TOKEN_INVALID' },
        401,
      );
    }
    req.decisionParticipant = participant;
    return true;
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const candidate = header.slice(7).trim();
    if (candidate) return candidate;
  }
  return null;
}
