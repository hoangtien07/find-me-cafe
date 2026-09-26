import { Module } from '@nestjs/common';
import { MapsModule } from '../maps/maps.module';
import { RateLimitModule } from '../common/rate-limit.module';
import { DecisionController } from './decision.controller';
import { DecisionInviteController } from './decision-invite.controller';
import { DecisionParticipantController } from './decision-participant.controller';
import { DecisionParticipantGuard } from './decision-participant.guard';
import { DecisionService } from './decision.service';
import { TravelMatrixService } from './travel/travel-matrix.service';
import { TRAVEL_MATRIX_PROVIDER } from './travel/travel-matrix.provider';
import { readEnv } from '../../app-config/env';
import { selectMatrixProvider } from './travel/matrix-provider-select';
import { DecisionResolverService } from './resolver/resolver.service';
import { DecisionTelemetryService } from './decision-telemetry.service';

/**
 * Decision domain — the "pick a venue" group-decision room. The session is a
 * 1:1 overlay on a technical TREK trip; this module owns the host-facing
 * lifecycle. RealtimeService/DatabaseService come from their global modules.
 */
@Module({
  imports: [MapsModule, RateLimitModule],
  controllers: [DecisionController, DecisionInviteController, DecisionParticipantController],
  providers: [
    DecisionService,
    DecisionParticipantGuard,
    TravelMatrixService,
    DecisionResolverService,
    DecisionTelemetryService,
    // mock (default/tests) | google | osrm — see selectMatrixProvider; a
    // real selection without its config refuses to boot rather than degrade.
    { provide: TRAVEL_MATRIX_PROVIDER, useFactory: () => selectMatrixProvider(readEnv().decision) },
  ],
  exports: [DecisionService, TravelMatrixService, DecisionResolverService],
})
export class DecisionModule {}
