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
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import { allPages, csvFile, isoDay } from '../common/csv.js';
import type { AuthUser } from '../common/auth.js';
import {
  BRANCH_ADMIN,
  CurrentUser,
  isAnyAdmin,
  RoleCode,
  Roles,
} from '../common/auth.js';
import { AccessService } from '../common/access.service.js';
import { FeesService } from './fees.service.js';
import { FeeAccess } from './fee-access.js';
import {
  CreateFeePlanDto,
  CreateInvoiceDto,
  CreateRefundDto,
  ListFeePlansQueryDto,
  ListInvoicesQueryDto,
  ListPaymentsQueryDto,
  RecordPaymentDto,
  UpdateFeePlanDto,
  UpdateInvoiceDto,
  UpdatePaymentStatusDto,
  UpdateRefundStatusDto,
} from './dto/fees.dto.js';

// Head office sees every branch; a branch admin only their own branches' fees (see FeeAccess).

@ApiTags('Fees')
@ApiBearerAuth()
@Controller('fee-plans')
export class FeePlansController {
  constructor(
    private readonly fees: FeesService,
    private readonly feeAccess: FeeAccess,
    private readonly access: AccessService,
  ) {}

  /** A plan for every branch (no batch or branch) is head office only. */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Post()
  async create(@Body() dto: CreateFeePlanDto, @CurrentUser() user: AuthUser) {
    await this.feeAccess.newPlan(user, dto.batchId, dto.branchId);
    return this.fees.createPlan(dto);
  }

  /** Branch admins see their branches' plans and the plans for every branch. */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Get()
  list(@Query() query: ListFeePlansQueryDto, @CurrentUser() user: AuthUser) {
    return this.fees.listPlans(query, this.access.adminBranches(user));
  }

  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    await this.feeAccess.readPlan(user, BigInt(id));
    return this.fees.getPlan(BigInt(id));
  }

  /** Invoices already raised keep their amounts. */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateFeePlanDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.feeAccess.writePlan(user, BigInt(id), dto.batchId);
    return this.fees.updatePlan(BigInt(id), dto);
  }
}

@ApiTags('Fees')
@ApiBearerAuth()
@Controller('fee-invoices')
export class FeeInvoicesController {
  constructor(
    private readonly fees: FeesService,
    private readonly feeAccess: FeeAccess,
    private readonly access: AccessService,
  ) {}

  /** Raise an invoice for an enrollment (DRAFT, or ISSUED with issue=true). */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Post()
  async create(@Body() dto: CreateInvoiceDto, @CurrentUser() user: AuthUser) {
    await this.feeAccess.enrollment(user, BigInt(dto.enrollmentId));
    return this.fees.createInvoice(dto);
  }

  /** `branchId` narrows to one branch (branch admins: one of theirs; by default all of them). */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Get()
  list(@Query() query: ListInvoicesQueryDto, @CurrentUser() user: AuthUser) {
    return this.fees.listInvoices(
      query,
      this.access.branchScope(user, query.branchId),
    );
  }

  /** The invoice list as a CSV download (same filters and branches as the list). */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @ApiProduces('text/csv')
  @Get('export')
  async export(
    @Query() query: ListInvoicesQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    const scope = this.access.branchScope(user, query.branchId);
    const rows = await allPages((page, limit) =>
      this.fees.listInvoices(
        Object.assign(new ListInvoicesQueryDto(), query, { page, limit }),
        scope,
      ),
    );
    return csvFile(
      'invoices',
      [
        'Invoice',
        'Status',
        'Student',
        'Admission no',
        'Batch',
        'Course',
        'Issued',
        'Due date',
        'Gross',
        'Discount',
        'Payable',
        'Paid',
        'Balance',
      ],
      rows.map((i) => [
        i.invoice_number,
        i.status,
        i.enrollments.student_profiles.users.full_name,
        i.enrollments.student_profiles.admission_number,
        i.enrollments.batches.code,
        i.enrollments.batches.courses.title,
        isoDay(i.issued_at),
        isoDay(i.due_date),
        i.gross_amount.toFixed(2),
        i.discount_amount.toFixed(2),
        i.amount_due?.toFixed(2) ?? '',
        i.amount_paid,
        i.balance_due,
      ]),
    );
  }

  /** Your issued invoices with payments and refunds. */
  @Roles(RoleCode.STUDENT)
  @Get('me')
  mine(@CurrentUser() user: AuthUser) {
    return this.fees.myInvoices(user);
  }

  /** Admins: any invoice of their branches. Students: their own issued invoices. */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN, RoleCode.STUDENT)
  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    if (isAnyAdmin(user)) await this.feeAccess.invoice(user, BigInt(id));
    return this.fees.getInvoiceFor(BigInt(id), user);
  }

  /** Edit a DRAFT invoice. */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateInvoiceDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.feeAccess.invoice(user, BigInt(id));
    return this.fees.updateInvoice(BigInt(id), dto);
  }

  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Post(':id/issue')
  async issue(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    await this.feeAccess.invoice(user, BigInt(id));
    return this.fees.issueInvoice(BigInt(id));
  }

  /** Cancel an invoice nothing has been (net) paid on. */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Post(':id/void')
  async void(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    await this.feeAccess.invoice(user, BigInt(id));
    return this.fees.voidInvoice(BigInt(id));
  }

  /**
   * Record money received. `idempotencyKey` makes retries safe: the same request returns the
   * original payment; reusing the key for a different payment is a 409.
   */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Post(':id/payments')
  async recordPayment(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RecordPaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.feeAccess.invoice(user, BigInt(id));
    return this.fees.recordPayment(BigInt(id), dto, user.id);
  }
}

@ApiTags('Fees')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly fees: FeesService,
    private readonly feeAccess: FeeAccess,
    private readonly access: AccessService,
  ) {}

  /**
   * The payments register with totals for the whole filter (confirmed amounts by method, refunds
   * made in the same period, net collection). Use from/to for a day's or month's collection.
   * Branch admins: their branches only.
   */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Get()
  findAll(@Query() query: ListPaymentsQueryDto, @CurrentUser() user: AuthUser) {
    return this.fees.listPayments(
      query,
      this.access.branchScope(user, query.branchId),
    );
  }

  /** The payments register as a CSV download (same filters and branches as the list). */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @ApiProduces('text/csv')
  @Get('export')
  async export(
    @Query() query: ListPaymentsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    const scope = this.access.branchScope(user, query.branchId);
    const rows = await allPages((page, limit) =>
      this.fees.listPayments(
        Object.assign(new ListPaymentsQueryDto(), query, { page, limit }),
        scope,
      ),
    );
    return csvFile(
      'payments',
      [
        'Paid on',
        'Receipt',
        'Invoice',
        'Student',
        'Admission no',
        'Batch',
        'Branch',
        'Method',
        'Amount',
        'Status',
        'Reference',
        'Received by',
        'Refunded',
      ],
      rows.map((p) => {
        const enrollment = p.fee_invoices.enrollments;
        const refunded = p.payment_refunds
          .filter((r) => r.status === 'CONFIRMED')
          .reduce((sum, r) => sum + Number(r.amount), 0);
        return [
          p.paid_at,
          p.receipt_number,
          p.fee_invoices.invoice_number,
          enrollment.student_profiles.users.full_name,
          enrollment.student_profiles.admission_number,
          enrollment.batches.code,
          enrollment.batches.branches.name,
          p.method,
          p.amount.toFixed(2),
          p.status,
          p.external_reference,
          p.users?.full_name,
          refunded.toFixed(2),
        ];
      }),
    );
  }

  @Roles(RoleCode.ADMIN, BRANCH_ADMIN, RoleCode.STUDENT)
  @Get(':id')
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    if (isAnyAdmin(user)) await this.feeAccess.payment(user, BigInt(id));
    return this.fees.getPaymentFor(BigInt(id), user);
  }

  /** Settle a PENDING payment: CONFIRMED (issues a receipt number), FAILED or CANCELLED. */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Patch(':id/status')
  async updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePaymentStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.feeAccess.payment(user, BigInt(id));
    return this.fees.updatePaymentStatus(BigInt(id), dto);
  }

  /** Refund part or all of a CONFIRMED payment (idempotent like payments). */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Post(':id/refunds')
  async refund(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateRefundDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.feeAccess.payment(user, BigInt(id));
    return this.fees.createRefund(BigInt(id), dto, user.id);
  }
}

@ApiTags('Fees')
@ApiBearerAuth()
@Controller('refunds')
export class RefundsController {
  constructor(
    private readonly fees: FeesService,
    private readonly feeAccess: FeeAccess,
  ) {}

  /** Settle a PENDING refund. */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Patch(':id/status')
  async updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRefundStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.feeAccess.refund(user, BigInt(id));
    return this.fees.updateRefundStatus(BigInt(id), dto);
  }
}
