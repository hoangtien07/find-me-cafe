import { Module } from '@nestjs/common';
import { VenuesRepository } from './venues.repository';
import { VenuesService } from './venues.service';

/**
 * The proprietary venue store — every third-party place record we paid for
 * or scraped lands here once and answers from SQLite afterwards. Exported so
 * MapsModule (search seam) and DecisionModule (snapshot enrichment) consume
 * the same canonical rows.
 */
@Module({
  providers: [VenuesRepository, VenuesService],
  exports: [VenuesService, VenuesRepository],
})
export class VenuesModule {}
