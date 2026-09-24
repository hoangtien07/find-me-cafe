import { Module } from '@nestjs/common';
import { DecisionController } from './decision.controller';
import { DecisionInviteController } from './decision-invite.controller';
import { DecisionParticipantController } from './decision-participant.controller';
import { DecisionParticipantGuard } from './decision-participant.guard';
import { DecisionService } from './decision.service';
import { TravelMatrixService } from './travel/travel-matrix.service';
import { MockTravelMatrixProvider } from './travel/mock-travel-matrix.provider';
import { TRAVEL_MATRIX_PROVIDER } from './travel/travel-matrix.provider';
import { DecisionResolverService } from './resolver/resolver.service';
import { DecisionTelemetryService } from './decision-telemetry.service';

/**
 * Decision domain — the "pick a venue" group-decision room. The session is a
 * 1:1 overlay on a technical TREK trip; this module owns the host-facing
 * lifecycle. RealtimeService/DatabaseService come from their global modules.
 */
@Module({
  controllers: [DecisionController, DecisionInviteController, DecisionParticipantController],
  providers: [
    DecisionService,
    DecisionParticipantGuard,
    TravelMatrixService,
    DecisionResolverService,
    DecisionTelemetryService,
    { provide: TRAVEL_MATRIX_PROVIDER, useClass: MockTravelMatrixProvider },
  ],
  exports: [DecisionService, TravelMatrixService, DecisionResolverService],
})
export class DecisionModule {}
