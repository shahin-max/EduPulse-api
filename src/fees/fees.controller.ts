import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../common/auth.js';
import { CurrentUser, RoleCode, Roles } from '../common/auth.js';
import { FeesService } from './fees.service.js';
import {
  CreateFeePlanDto,
  CreateInvoiceDto,
  CreateRefundDto,
  ListFeePlansQueryDto,
  ListInvoicesQueryDto,
  RecordPaymentDto,
  UpdateFeePlanDto,
  UpdateInvoiceDto,
  UpdatePaymentStatusDto,
  UpdateRefundStatusDto,
} from './dto/fees.dto.js';

@ApiTags('Fees')
@ApiBearerAuth()
@Controller('fee-plans')
export class FeePlansController {
  constructor(private readonly fees: FeesService) {}

  @Roles(RoleCode.ADMIN)
  @Post()
  create(@Body() dto: CreateFeePlanDto) {
    return this.fees.createPlan(dto);
  }

  @Roles(RoleCode.ADMIN)
  @Get()
  list(@Query() query: ListFeePlansQueryDto) {
    return this.fees.listPlans(query);
  }

  @Roles(RoleCode.ADMIN)
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.fees.getPlan(BigInt(id));
  }

  /** Invoices already raised keep their amounts. */
  @Roles(RoleCode.ADMIN)
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateFeePlanDto) {
    return this.fees.updatePlan(BigInt(id), dto);
  }
}

@ApiTags('Fees')
@ApiBearerAuth()
@Controller('fee-invoices')
export class FeeInvoicesController {
  constructor(private readonly fees: FeesService) {}

  /** Raise an invoice for an enrollment (DRAFT, or ISSUED with issue=true). */
  @Roles(RoleCode.ADMIN)
  @Post()
  create(@Body() dto: CreateInvoiceDto) {
    return this.fees.createInvoice(dto);
  }

  @Roles(RoleCode.ADMIN)
  @Get()
  list(@Query() query: ListInvoicesQueryDto) {
    return this.fees.listInvoices(query);
  }

  /** Your issued invoices with payments and refunds. */
  @Roles(RoleCode.STUDENT)
  @Get('me')
  mine(@CurrentUser() user: AuthUser) {
    return this.fees.myInvoices(user);
  }

  /** Admins: any invoice. Students: their own issued invoices. */
  @Roles(RoleCode.ADMIN, RoleCode.STUDENT)
  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fees.getInvoiceFor(BigInt(id), user);
  }

  /** Edit a DRAFT invoice. */
  @Roles(RoleCode.ADMIN)
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateInvoiceDto) {
    return this.fees.updateInvoice(BigInt(id), dto);
  }

  @Roles(RoleCode.ADMIN)
  @Post(':id/issue')
  issue(@Param('id', ParseIntPipe) id: number) {
    return this.fees.issueInvoice(BigInt(id));
  }

  /** Cancel an invoice nothing has been (net) paid on. */
  @Roles(RoleCode.ADMIN)
  @Post(':id/void')
  void(@Param('id', ParseIntPipe) id: number) {
    return this.fees.voidInvoice(BigInt(id));
  }

  /**
   * Record money received. `idempotencyKey` makes retries safe: the same request returns the
   * original payment; reusing the key for a different payment is a 409.
   */
  @Roles(RoleCode.ADMIN)
  @Post(':id/payments')
  recordPayment(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RecordPaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fees.recordPayment(BigInt(id), dto, user.id);
  }
}

@ApiTags('Fees')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly fees: FeesService) {}

  @Roles(RoleCode.ADMIN, RoleCode.STUDENT)
  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fees.getPaymentFor(BigInt(id), user);
  }

  /** Settle a PENDING payment: CONFIRMED (issues a receipt number), FAILED or CANCELLED. */
  @Roles(RoleCode.ADMIN)
  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePaymentStatusDto,
  ) {
    return this.fees.updatePaymentStatus(BigInt(id), dto);
  }

  /** Refund part or all of a CONFIRMED payment (idempotent like payments). */
  @Roles(RoleCode.ADMIN)
  @Post(':id/refunds')
  refund(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateRefundDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.fees.createRefund(BigInt(id), dto, user.id);
  }
}

@ApiTags('Fees')
@ApiBearerAuth()
@Controller('refunds')
export class RefundsController {
  constructor(private readonly fees: FeesService) {}

  /** Settle a PENDING refund. */
  @Roles(RoleCode.ADMIN)
  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRefundStatusDto,
  ) {
    return this.fees.updateRefundStatus(BigInt(id), dto);
  }
}
