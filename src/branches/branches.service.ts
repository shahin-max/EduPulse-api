import { Injectable, NotFoundException } from '@nestjs/common';
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
  create(dto: CreateBranchDto) {
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
    return this.prisma.branches.update({
      where: { id },
      data: toRow(dto),
      include: withCounts,
    });
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
