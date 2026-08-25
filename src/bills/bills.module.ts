import { Module } from '@nestjs/common';
import { BillsController } from './bills.controller';
import { BillsService } from './bills.service';

/**
 * Bills module — PRD 3.3 / ARCHITECTURE §7.3.
 * Students create/edit/archive their needs; the public reads them and
 * their (anonymised) contribution history. `raised`/`status` are always
 * recomputed via AggregationService — never trusted from the client.
 */
@Module({
  controllers: [BillsController],
  providers: [BillsService],
  exports: [BillsService],
})
export class BillsModule {}
