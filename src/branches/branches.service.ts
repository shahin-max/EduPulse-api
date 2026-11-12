import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateBranchDto, UpdateBranchDto } from './dto/branch.dto.js';

const withCounts = {
  _count: { select: { batches: true, branch_staff: true } },
} as const;

@Injectable()
export class BranchesService {
  constructor(private readonly prisma: PrismaService) {}

  list(includeInactive: boolean) {
    return this.prisma.branches.findMany({
      where: includeInactive ? {} : { is_active: true },
      include: withCounts,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: bigint) {
    const branch = await this.prisma.branches.findUnique({
      where: { id },
      include: withCounts,
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  /** A duplicate code becomes a 409 through PrismaExceptionFilter (P2002). */
  async create(dto: CreateBranchDto) {
    await this.assertPrefixesFree(dto);
    return this.prisma.branches.create({
      data: {
        ...toRow(dto),
        code: dto.code,
        name: dto.name,
        invoice_prefix: dto.invoicePrefix,
        receipt_prefix: dto.receiptPrefix,
      },
      include: withCounts,
    });
  }

  async update(id: bigint, dto: UpdateBranchDto) {
    await this.findOne(id);
    await this.assertPrefixesFree(dto, id);
    return this.prisma.branches.update({
      where: { id },
      data: toRow(dto),
      include: withCounts,
    });
  }

  /**
   * Invoice and receipt numbers are "<prefix>/<year>/<n>" with a sequence per branch, so two branches
   * sharing a prefix would produce the same numbers.
   */
  private async assertPrefixesFree(dto: UpdateBranchDto, exceptId?: bigint) {
    const checks = [
      { field: 'invoice_prefix', value: dto.invoicePrefix, label: 'invoice' },
      { field: 'receipt_prefix', value: dto.receiptPrefix, label: 'receipt' },
    ] as const;
    for (const { field, value, label } of checks) {
      if (value === undefined) continue;
      const other = await this.prisma.branches.findFirst({
        where: {
          [field]: value,
          ...(exceptId ? { id: { not: exceptId } } : {}),
        },
        select: { name: true },
      });
      if (other)
        throw new ConflictException(
          `The ${label} prefix ${value} is already used by ${other.name}; each branch needs its own`,
        );
    }
  }
}

function toRow(dto: UpdateBranchDto) {
  return {
    code: dto.code,
    name: dto.name,
    invoice_prefix: dto.invoicePrefix,
    receipt_prefix: dto.receiptPrefix,
    address: dto.address,
    city: dto.city,
    state: dto.state,
    pincode: dto.pincode,
    phone: dto.phone,
    email: dto.email,
    gstin: dto.gstin,
    is_active: dto.isActive,
  };
}
