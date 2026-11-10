import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthUser, isAdmin } from '../common/auth.js';
import { paginated, skipTake } from '../common/pagination.js';
import { documentNumber, invoiceState, money, sum } from './invoice-math.js';
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

type Tx = Prisma.TransactionClient;

const paymentInclude = {
  payment_refunds: { orderBy: { id: 'asc' } },
} satisfies Prisma.paymentsInclude;

const invoiceInclude = {
  fee_plans: { select: { id: true, title: true, currency: true } },
  enrollments: {
    select: {
      id: true,
      student_user_id: true,
      student_profiles: {
        select: {
          admission_number: true,
          users: { select: { full_name: true } },
        },
      },
      batches: {
        select: {
          id: true,
          code: true,
          name: true,
          courses: { select: { id: true, code: true, title: true } },
        },
      },
    },
  },
  payments: { include: paymentInclude, orderBy: { id: 'asc' } },
} satisfies Prisma.fee_invoicesInclude;

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

@Injectable()
export class FeesService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- fee plans

  async createPlan(dto: CreateFeePlanDto) {
    const courseId = BigInt(dto.courseId);
    const course = await this.prisma.courses.findUnique({
      where: { id: courseId },
      select: { id: true },
    });
    if (!course)
      throw new BadRequestException('courseId does not match any course');
    await this.assertBatchOfCourse(courseId, dto.batchId);
    return this.prisma.fee_plans.create({
      data: {
        course_id: courseId,
        batch_id: dto.batchId == null ? null : BigInt(dto.batchId),
        title: dto.title,
        currency: dto.currency,
        amount: money(dto.amount),
        is_active: dto.isActive,
      },
    });
  }

  listPlans(query: ListFeePlansQueryDto) {
    return this.prisma.fee_plans.findMany({
      where: {
        course_id:
          query.courseId === undefined ? undefined : BigInt(query.courseId),
        batch_id:
          query.batchId === undefined ? undefined : BigInt(query.batchId),
        ...(query.activeOnly ? { is_active: true } : {}),
      },
      include: {
        courses: { select: { id: true, code: true, title: true } },
        batches: { select: { id: true, code: true, name: true } },
      },
      orderBy: { id: 'desc' },
    });
  }

  async getPlan(id: bigint) {
    const plan = await this.prisma.fee_plans.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Fee plan not found');
    return plan;
  }

  /** Changing the amount does not touch invoices already raised from the plan. */
  async updatePlan(id: bigint, dto: UpdateFeePlanDto) {
    const plan = await this.getPlan(id);
    if (dto.batchId !== undefined)
      await this.assertBatchOfCourse(plan.course_id, dto.batchId);
    return this.prisma.fee_plans.update({
      where: { id },
      data: {
        batch_id:
          dto.batchId === undefined
            ? undefined
            : dto.batchId === null
              ? null
              : BigInt(dto.batchId),
        title: dto.title,
        amount: dto.amount === undefined ? undefined : money(dto.amount),
        is_active: dto.isActive,
      },
    });
  }

  // ---------------------------------------------------------------- invoices

  async createInvoice(dto: CreateInvoiceDto) {
    const enrollment = await this.prisma.enrollments.findUnique({
      where: { id: BigInt(dto.enrollmentId) },
      select: {
        id: true,
        batch_id: true,
        batches: { select: { course_id: true } },
      },
    });
    if (!enrollment)
      throw new BadRequestException(
        'enrollmentId does not match any enrollment',
      );

    let gross =
      dto.grossAmount === undefined ? undefined : money(dto.grossAmount);
    let description = dto.description;
    if (dto.feePlanId !== undefined) {
      const plan = await this.prisma.fee_plans.findUnique({
        where: { id: BigInt(dto.feePlanId) },
      });
      if (!plan || !plan.is_active)
        throw new BadRequestException(
          'feePlanId does not match an active fee plan',
        );
      if (
        plan.course_id !== enrollment.batches.course_id ||
        (plan.batch_id !== null && plan.batch_id !== enrollment.batch_id)
      ) {
        throw new BadRequestException(
          "This fee plan does not apply to the enrollment's batch",
        );
      }
      gross ??= plan.amount;
      description ??= plan.title;
    }
    if (gross === undefined)
      throw new BadRequestException(
        'grossAmount is required when no fee plan is given',
      );
    const discount = money(dto.discountAmount ?? 0);
    assertDiscount(gross, discount);

    const now = new Date();
    const id = await this.prisma.$transaction(async (tx) => {
      // The invoice number is derived from the row id, so insert with a placeholder first.
      const created = await tx.fee_invoices.create({
        data: {
          invoice_number: `TMP-${randomUUID()}`,
          enrollment_id: enrollment.id,
          fee_plan_id:
            dto.feePlanId === undefined ? null : BigInt(dto.feePlanId),
          description,
          gross_amount: gross,
          discount_amount: discount,
          due_date: dto.dueDate,
          status: dto.issue ? 'ISSUED' : 'DRAFT',
          issued_at: dto.issue ? now : null,
        },
      });
      await tx.fee_invoices.update({
        where: { id: created.id },
        data: { invoice_number: documentNumber('INV', created.id, now) },
      });
      return created.id;
    });
    return this.loadInvoice(id);
  }

  async listInvoices(query: ListInvoicesQueryDto) {
    const where: Prisma.fee_invoicesWhereInput = {
      enrollment_id:
        query.enrollmentId === undefined
          ? undefined
          : BigInt(query.enrollmentId),
      status: query.status,
      enrollments: {
        student_user_id:
          query.studentUserId === undefined
            ? undefined
            : BigInt(query.studentUserId),
        batch_id:
          query.batchId === undefined ? undefined : BigInt(query.batchId),
      },
      ...(query.overdue
        ? {
            due_date: { lt: startOfToday() },
            status: { in: ['ISSUED', 'PART_PAID'] },
          }
        : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.fee_invoices.findMany({
        where,
        include: invoiceInclude,
        orderBy: { id: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.fee_invoices.count({ where }),
    ]);
    return paginated(data.map(presentInvoice), total, query);
  }

  /** Admins see any invoice; students see their own issued (non-draft) invoices. */
  async getInvoiceFor(id: bigint, user: AuthUser) {
    const invoice = await this.loadInvoice(id);
    if (
      !isAdmin(user) &&
      (invoice.enrollments.student_user_id !== user.id ||
        invoice.status === 'DRAFT')
    ) {
      throw new NotFoundException('Invoice not found');
    }
    return invoice;
  }

  async myInvoices(user: AuthUser) {
    const invoices = await this.prisma.fee_invoices.findMany({
      where: {
        enrollments: { student_user_id: user.id },
        status: { not: 'DRAFT' },
      },
      include: invoiceInclude,
      orderBy: [{ due_date: 'asc' }, { id: 'asc' }],
    });
    return invoices.map(presentInvoice);
  }

  async updateInvoice(id: bigint, dto: UpdateInvoiceDto) {
    const invoice = await this.getInvoiceRow(id);
    if (invoice.status !== 'DRAFT')
      throw new BadRequestException(
        'Only DRAFT invoices can be edited; void it and raise a new one',
      );
    const gross =
      dto.grossAmount === undefined
        ? invoice.gross_amount
        : money(dto.grossAmount);
    const discount =
      dto.discountAmount === undefined
        ? invoice.discount_amount
        : money(dto.discountAmount);
    assertDiscount(gross, discount);
    await this.prisma.fee_invoices.update({
      where: { id },
      data: {
        description: dto.description,
        gross_amount: gross,
        discount_amount: discount,
        due_date: dto.dueDate,
      },
    });
    return this.loadInvoice(id);
  }

  async issueInvoice(id: bigint) {
    const invoice = await this.getInvoiceRow(id);
    if (invoice.status !== 'DRAFT')
      throw new BadRequestException('Only DRAFT invoices can be issued');
    await this.prisma.fee_invoices.update({
      where: { id },
      data: { status: 'ISSUED', issued_at: new Date() },
    });
    return this.loadInvoice(id);
  }

  /** Voiding is allowed while nothing is (net) paid: no confirmed payments, or all of them refunded. */
  async voidInvoice(id: bigint) {
    await this.prisma.$transaction(async (tx) => {
      await lockInvoice(tx, id);
      const invoice = await tx.fee_invoices.findUniqueOrThrow({
        where: { id },
        include: { payments: { include: paymentInclude } },
      });
      if (invoice.status === 'VOID')
        throw new BadRequestException('Invoice is already void');
      const { paid } = invoiceState(invoice, invoice.payments);
      if (!paid.isZero()) {
        throw new BadRequestException(
          'Refund the confirmed payments before voiding this invoice',
        );
      }
      if (invoice.payments.some((p) => p.status === 'PENDING')) {
        throw new BadRequestException(
          'Resolve the pending payments before voiding this invoice',
        );
      }
      await tx.fee_invoices.update({ where: { id }, data: { status: 'VOID' } });
    });
    return this.loadInvoice(id);
  }

  // ---------------------------------------------------------------- payments

  async recordPayment(
    invoiceId: bigint,
    dto: RecordPaymentDto,
    actorId: bigint,
  ) {
    const amount = money(dto.amount);
    if (amount.lte(0))
      throw new BadRequestException('amount must be greater than 0');
    const replay = await this.findPaymentReplay(invoiceId, dto, amount);
    if (replay) return replay;

    try {
      const paymentId = await this.prisma.$transaction(async (tx) => {
        await lockInvoice(tx, invoiceId);
        const invoice = await tx.fee_invoices.findUniqueOrThrow({
          where: { id: invoiceId },
          include: {
            payments: { include: paymentInclude },
            fee_plans: { select: { currency: true } },
          },
        });
        if (invoice.status !== 'ISSUED' && invoice.status !== 'PART_PAID') {
          throw new BadRequestException(
            `Payments can only be recorded against ISSUED or PART_PAID invoices (this one is ${invoice.status})`,
          );
        }
        const { balanceDue } = invoiceState(invoice, invoice.payments);
        const status = dto.status ?? 'CONFIRMED';
        const pending = sum(
          invoice.payments
            .filter((p) => p.status === 'PENDING')
            .map((p) => p.amount),
        );
        const room =
          status === 'CONFIRMED' ? balanceDue : balanceDue.minus(pending);
        if (amount.gt(room))
          throw new BadRequestException(
            `amount exceeds the ${room.toFixed(2)} still due on this invoice`,
          );

        const now = new Date();
        const payment = await tx.payments.create({
          data: {
            invoice_id: invoiceId,
            amount,
            currency: invoice.fee_plans?.currency ?? 'INR',
            method: dto.method,
            provider: dto.provider,
            external_reference: dto.externalReference,
            idempotency_key: dto.idempotencyKey,
            status,
            paid_at: status === 'CONFIRMED' ? (dto.paidAt ?? now) : dto.paidAt,
            recorded_by: actorId,
            notes: dto.notes,
          },
        });
        if (status === 'CONFIRMED') {
          await tx.payments.update({
            where: { id: payment.id },
            data: { receipt_number: documentNumber('RCT', payment.id, now) },
          });
          await recompute(tx, invoiceId);
        }
        return payment.id;
      });
      return this.loadPayment(paymentId);
    } catch (error) {
      // Two identical requests raced past the replay check: the loser returns the winner's payment.
      if (isUniqueViolation(error)) {
        const winner = await this.findPaymentReplay(invoiceId, dto, amount);
        if (winner) return winner;
      }
      throw error;
    }
  }

  async getPaymentFor(id: bigint, user: AuthUser) {
    const payment = await this.loadPayment(id);
    if (!isAdmin(user)) {
      const owner = await this.prisma.fee_invoices.findUnique({
        where: { id: payment.invoice_id },
        select: {
          status: true,
          enrollments: { select: { student_user_id: true } },
        },
      });
      if (owner?.enrollments.student_user_id !== user.id)
        throw new NotFoundException('Payment not found');
    }
    return payment;
  }

  async updatePaymentStatus(id: bigint, dto: UpdatePaymentStatusDto) {
    const existing = await this.prisma.payments.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Payment not found');
    await this.prisma.$transaction(async (tx) => {
      await lockInvoice(tx, existing.invoice_id);
      const payment = await tx.payments.findUniqueOrThrow({ where: { id } });
      if (payment.status !== 'PENDING')
        throw new BadRequestException(
          `Only PENDING payments can change status (this one is ${payment.status})`,
        );
      const now = new Date();
      if (dto.status === 'CONFIRMED') {
        const invoice = await tx.fee_invoices.findUniqueOrThrow({
          where: { id: payment.invoice_id },
          include: { payments: { include: paymentInclude } },
        });
        if (invoice.status === 'VOID')
          throw new BadRequestException('The invoice has been voided');
        const { balanceDue } = invoiceState(invoice, invoice.payments);
        if (payment.amount.gt(balanceDue))
          throw new BadRequestException(
            `amount exceeds the ${balanceDue.toFixed(2)} still due on this invoice`,
          );
      }
      await tx.payments.update({
        where: { id },
        data: {
          status: dto.status,
          ...(dto.status === 'CONFIRMED'
            ? {
                paid_at: dto.paidAt ?? payment.paid_at ?? now,
                receipt_number: documentNumber('RCT', id, now),
              }
            : {}),
        },
      });
      await recompute(tx, payment.invoice_id);
    });
    return this.loadPayment(id);
  }

  // ---------------------------------------------------------------- refunds

  async createRefund(paymentId: bigint, dto: CreateRefundDto, actorId: bigint) {
    const amount = money(dto.amount);
    if (amount.lte(0))
      throw new BadRequestException('amount must be greater than 0');
    const replay = await this.findRefundReplay(paymentId, dto, amount);
    if (replay) return replay;
    const payment = await this.prisma.payments.findUnique({
      where: { id: paymentId },
    });
    if (!payment) throw new NotFoundException('Payment not found');

    try {
      await this.prisma.$transaction(async (tx) => {
        await lockInvoice(tx, payment.invoice_id);
        const current = await tx.payments.findUniqueOrThrow({
          where: { id: paymentId },
          include: paymentInclude,
        });
        if (current.status !== 'CONFIRMED')
          throw new BadRequestException(
            'Only CONFIRMED payments can be refunded',
          );
        const committed = sum(
          current.payment_refunds
            .filter((r) => r.status === 'PENDING' || r.status === 'CONFIRMED')
            .map((r) => r.amount),
        );
        const refundable = current.amount.minus(committed);
        if (amount.gt(refundable))
          throw new BadRequestException(
            `amount exceeds the ${refundable.toFixed(2)} still refundable on this payment`,
          );
        const status = dto.status ?? 'CONFIRMED';
        await tx.payment_refunds.create({
          data: {
            payment_id: paymentId,
            amount,
            status,
            idempotency_key: dto.idempotencyKey,
            external_reference: dto.externalReference,
            reason: dto.reason,
            refunded_at: status === 'CONFIRMED' ? new Date() : null,
            recorded_by: actorId,
          },
        });
        if (status === 'CONFIRMED') await recompute(tx, payment.invoice_id);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await this.findRefundReplay(paymentId, dto, amount);
        if (winner) return winner;
      }
      throw error;
    }
    return this.prisma.payment_refunds.findUniqueOrThrow({
      where: { idempotency_key: dto.idempotencyKey },
    });
  }

  async updateRefundStatus(id: bigint, dto: UpdateRefundStatusDto) {
    const refund = await this.prisma.payment_refunds.findUnique({
      where: { id },
      include: { payments: { select: { invoice_id: true } } },
    });
    if (!refund) throw new NotFoundException('Refund not found');
    return this.prisma.$transaction(async (tx) => {
      await lockInvoice(tx, refund.payments.invoice_id);
      const current = await tx.payment_refunds.findUniqueOrThrow({
        where: { id },
      });
      if (current.status !== 'PENDING')
        throw new BadRequestException(
          `Only PENDING refunds can change status (this one is ${current.status})`,
        );
      const updated = await tx.payment_refunds.update({
        where: { id },
        data: {
          status: dto.status,
          ...(dto.status === 'CONFIRMED' ? { refunded_at: new Date() } : {}),
        },
      });
      await recompute(tx, refund.payments.invoice_id);
      return updated;
    });
  }

  // ---------------------------------------------------------------- helpers

  /** Same key + same request -> the original payment. Same key + different request -> 409. */
  private async findPaymentReplay(
    invoiceId: bigint,
    dto: RecordPaymentDto,
    amount: Prisma.Decimal,
  ) {
    const existing = await this.prisma.payments.findUnique({
      where: { idempotency_key: dto.idempotencyKey },
    });
    if (!existing) return null;
    const same =
      existing.invoice_id === invoiceId &&
      existing.amount.equals(amount) &&
      existing.method === dto.method &&
      (existing.provider ?? null) === (dto.provider ?? null) &&
      (existing.external_reference ?? null) === (dto.externalReference ?? null);
    if (!same)
      throw new ConflictException(
        'This idempotencyKey was already used for a different payment',
      );
    return this.loadPayment(existing.id);
  }

  private async findRefundReplay(
    paymentId: bigint,
    dto: CreateRefundDto,
    amount: Prisma.Decimal,
  ) {
    const existing = await this.prisma.payment_refunds.findUnique({
      where: { idempotency_key: dto.idempotencyKey },
    });
    if (!existing) return null;
    if (existing.payment_id !== paymentId || !existing.amount.equals(amount)) {
      throw new ConflictException(
        'This idempotencyKey was already used for a different refund',
      );
    }
    return existing;
  }

  private async assertBatchOfCourse(
    courseId: bigint,
    batchId?: number | null,
  ): Promise<void> {
    if (batchId === undefined || batchId === null) return;
    const batch = await this.prisma.batches.findUnique({
      where: { id: BigInt(batchId) },
      select: { course_id: true },
    });
    if (!batch || batch.course_id !== courseId)
      throw new BadRequestException(
        'batchId must be a batch of the same course',
      );
  }

  private async getInvoiceRow(id: bigint) {
    const invoice = await this.prisma.fee_invoices.findUnique({
      where: { id },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  private async loadInvoice(id: bigint) {
    const invoice = await this.prisma.fee_invoices.findUnique({
      where: { id },
      include: invoiceInclude,
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return presentInvoice(invoice);
  }

  private async loadPayment(id: bigint) {
    const payment = await this.prisma.payments.findUnique({
      where: { id },
      include: paymentInclude,
    });
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }
}

/** Serialises every money change on one invoice (SELECT ... FOR UPDATE). */
async function lockInvoice(tx: Tx, invoiceId: bigint): Promise<void> {
  const rows = await tx.$queryRaw<
    { id: bigint }[]
  >`SELECT id FROM fee_invoices WHERE id = ${invoiceId} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('Invoice not found');
}

/** Re-derives the status from the invoice's confirmed payments and refunds (amount_due is generated by MySQL). */
async function recompute(tx: Tx, invoiceId: bigint): Promise<void> {
  const invoice = await tx.fee_invoices.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { payments: { include: paymentInclude } },
  });
  const { status } = invoiceState(invoice, invoice.payments);
  if (status !== invoice.status)
    await tx.fee_invoices.update({
      where: { id: invoiceId },
      data: { status },
    });
}

type InvoiceRow = Prisma.fee_invoicesGetPayload<{
  include: typeof invoiceInclude;
}>;

/**
 * Adds what has been paid and what is still owed. `amount_due` (from the database) is the
 * payable amount, gross - discount; `balance_due` is what remains after payments and refunds.
 */
function presentInvoice(invoice: InvoiceRow) {
  const { paid, balanceDue } = invoiceState(invoice, invoice.payments);
  return {
    ...invoice,
    amount_paid: paid.toFixed(2),
    balance_due: balanceDue.toFixed(2),
  };
}

/** Mirrors chk_invoice_amount. */
function assertDiscount(gross: Prisma.Decimal, discount: Prisma.Decimal): void {
  if (discount.gt(gross))
    throw new BadRequestException('discountAmount cannot exceed grossAmount');
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}
