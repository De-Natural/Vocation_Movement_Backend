import { Global, Module } from '@nestjs/common';
import { AggregationService } from './aggregation.service';

/**
 * Global aggregation module. Owns the single source of truth for
 * server-derived financial values so payments, bills, religious, sponsor
 * and admin modules all recompute the same way.
 */
@Global()
@Module({
  providers: [AggregationService],
  exports: [AggregationService],
})
export class AggregationModule {}
