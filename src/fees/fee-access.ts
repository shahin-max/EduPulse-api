import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../common/access.service.js';
import { AuthUser, isAdmin } from '../common/auth.js';

/**
 * Branch checks for the fee routes. Head office passes every check; a branch admin only reaches
 * plans, invoices, payments and refunds of their own branches (fee plans for every branch are
 * read-only to them). Run before the operation, so a replayed idempotent request is checked too.
 */
@Injectable()
export class FeeAccess {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  async invoice(user: AuthUser, id: bigint): Promise<void> {
    if (isAdmin(user)) return;
    const row = await this.prisma.fee_invoices.findUnique({
      where: { id },
      select: { branch_id: true },
    });
    if (!row) throw new NotFoundException('Invoice not found');
    this.access.assertBranchAdmin(user, row.branch_id);
  }

  async payment(user: AuthUser, id: bigint): Promise<void> {
    if (isAdmin(user)) return;
    const row = await this.prisma.payments.findUnique({
      where: { id },
      select: { branch_id: true },
    });
    if (!row) throw new NotFoundException('Payment not found');
    this.access.assertBranchAdmin(user, row.branch_id);
  }

  async refund(user: AuthUser, id: bigint): Promise<void> {
    if (isAdmin(user)) return;
    const row = await this.prisma.payment_refunds.findUnique({
      where: { id },
      select: { payments: { select: { branch_id: true } } },
    });
    if (!row) throw new NotFoundException('Refund not found');
    this.access.assertBranchAdmin(user, row.payments.branch_id);
  }

  async enrollment(user: AuthUser, id: bigint): Promise<void> {
    if (isAdmin(user)) return;
    const row = await this.prisma.enrollments.findUnique({
      where: { id },
      select: { branch_id: true },
    });
    // The service answers "does not match any enrollment" for a missing one.
    if (row) this.access.assertBranchAdmin(user, row.branch_id);
  }

  /** Reading a plan: plans for every branch are open to branch admins, others only at their branch. */
  async readPlan(user: AuthUser, id: bigint): Promise<void> {
    if (isAdmin(user)) return;
    const plan = await this.prisma.fee_plans.findUnique({
      where: { id },
      select: { branch_id: true },
    });
    if (!plan) throw new NotFoundException('Fee plan not found');
    if (plan.branch_id !== null)
      this.access.assertBranchAdmin(user, plan.branch_id);
  }

  /** Changing a plan: only plans of the admin's branch (and only onto a batch of that branch). */
  async writePlan(
    user: AuthUser,
    id: bigint,
    batchId?: number | null,
  ): Promise<void> {
    if (isAdmin(user)) return;
    const plan = await this.prisma.fee_plans.findUnique({
      where: { id },
      select: { branch_id: true },
    });
    if (!plan) throw new NotFoundException('Fee plan not found');
    this.access.assertBranchAdmin(user, plan.branch_id);
    if (batchId !== undefined && batchId !== null)
      await this.batch(user, batchId);
  }

  /** A new plan belongs to its batch's branch, else the given branch, else every branch (head office). */
  async newPlan(
    user: AuthUser,
    batchId?: number | null,
    branchId?: number,
  ): Promise<void> {
    if (isAdmin(user)) return;
    if (batchId !== undefined && batchId !== null)
      return this.batch(user, batchId);
    this.access.assertBranchAdmin(
      user,
      branchId === undefined ? null : BigInt(branchId),
    );
  }

  private async batch(user: AuthUser, batchId: number): Promise<void> {
    const batch = await this.prisma.batches.findUnique({
      where: { id: BigInt(batchId) },
      select: { branch_id: true },
    });
    // The service reports a missing batch with its own message.
    if (batch) this.access.assertBranchAdmin(user, batch.branch_id);
  }
}
