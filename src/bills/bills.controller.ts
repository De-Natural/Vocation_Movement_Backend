import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { BillsService } from './bills.service';
import { ok } from '../common/http/response';
import { Public, Roles, CurrentUser } from '../common';
import { AuthUser } from '../common/auth/jwt-payload';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  createBillSchema,
  CreateBillInput,
  updateBillSchema,
  UpdateBillInput,
} from './bills.dto';

@Controller('bills')
export class BillsController {
  constructor(private readonly bills: BillsService) {}

  // GET /api/bills/religious/:id — public list of a student's active bills
  @Public()
  @Get('religious/:id')
  async listForReligious(@Param('id') religiousId: string) {
    const bills = await this.bills.listForReligious(religiousId);
    return ok(bills);
  }

  // POST /api/bills — create (student only)
  @Roles('RELIGIOUS')
  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createBillSchema)) dto: CreateBillInput,
  ) {
    const bill = await this.bills.create(user.userId, dto);
    return ok(bill, 'Bill added to your Bill Board');
  }

  // PUT /api/bills/:id — full edit (student only)
  @Roles('RELIGIOUS')
  @Put(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') billId: string,
    @Body(new ZodValidationPipe(updateBillSchema)) dto: UpdateBillInput,
  ) {
    const bill = await this.bills.update(user.userId, billId, dto);
    return ok(bill, 'Bill updated');
  }

  // PATCH /api/bills/:id/archive — soft-hide (student only)
  @Roles('RELIGIOUS')
  @Patch(':id/archive')
  async archive(@CurrentUser() user: AuthUser, @Param('id') billId: string) {
    const bill = await this.bills.archive(user.userId, billId);
    return ok(bill, 'Bill archived and hidden from public view');
  }

  // GET /api/bills/:id/contributions — public contribution history (anonymised)
  @Public()
  @Get(':id/contributions')
  async contributions(@Param('id') billId: string) {
    const contributions = await this.bills.contributions(billId);
    return ok(contributions);
  }

  // GET /api/bills/:id — public single bill
  @Public()
  @Get(':id')
  async getOne(@Param('id') billId: string) {
    const bill = await this.bills.getOne(billId);
    return ok(bill);
  }
}
