import { Module } from '@nestjs/common';
import { DecisionController } from './decision.controller';
import { DecisionInviteController } from './decision-invite.controller';
import { DecisionService } from './decision.service';

/**
 * Decision domain — the "pick a venue" group-decision room. The session is a
 * 1:1 overlay on a technical TREK trip; this module owns the host-facing
 * lifecycle. RealtimeService/DatabaseService come from their global modules.
 */
@Module({
  controllers: [DecisionController, DecisionInviteController],
  providers: [DecisionService],
  exports: [DecisionService],
})
export class DecisionModule {}
