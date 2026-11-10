import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PasswordService } from '../auth/password.service.js';
import { OneTimeTokenService } from '../auth/one-time-token.service.js';
import { assertContactFree, revokeAllSessions } from '../auth/auth.service.js';
import { AuthUser, RoleCode } from '../common/auth.js';
import { paginated, skipTake } from '../common/pagination.js';
import { safeUserSelect, userDetailSelect, withRoles } from './user-select.js';
import {
  CreateUserDto,
  ListUsersQueryDto,
  UpdateUserDto,
} from './dto/user.dto.js';

type Tx = Prisma.TransactionClient;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: OneTimeTokenService,
  ) {}

  /** Creates an account with its roles and the matching student/faculty profile rows. */
  async create(dto: CreateUserDto) {
    await assertContactFree(this.prisma, dto.email, dto.mobile);
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.users.create({
        data: {
          public_id: randomUUID(),
          full_name: dto.fullName,
          email: dto.email,
          mobile: dto.mobile,
          password_hash: dto.password
            ? await this.passwords.hash(dto.password)
            : null,
          status: dto.password ? 'ACTIVE' : 'PENDING',
          user_roles: {
            create: dto.roles.map((code) => ({ roles: { connect: { code } } })),
          },
        },
        select: { id: true },
      });
      await ensureProfiles(tx, created.id, dto.roles);
      return tx.users.findUniqueOrThrow({
        where: { id: created.id },
        select: userDetailSelect,
      });
    });
    const setupToken = dto.password
      ? undefined
      : await this.tokens.issue(user.id, 'PASSWORD_RESET');
    return { ...withRoles(user), ...(setupToken ? { setupToken } : {}) };
  }

  async findAll(query: ListUsersQueryDto) {
    const where: Prisma.usersWhereInput = {
      status: query.status,
      ...(query.includeDeleted ? {} : { deleted_at: null }),
      ...(query.role
        ? { user_roles: { some: { roles: { code: query.role } } } }
        : {}),
      ...(query.search
        ? {
            OR: [
              { full_name: { contains: query.search } },
              { email: { contains: query.search } },
              { mobile: { contains: query.search.replace(/\s+/g, '') } },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.users.findMany({
        where,
        select: safeUserSelect,
        orderBy: { id: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.users.count({ where }),
    ]);
    return paginated(rows.map(withRoles), total, query);
  }

  async findOne(id: bigint) {
    const user = await this.prisma.users.findUnique({
      where: { id },
      select: userDetailSelect,
    });
    if (!user) throw new NotFoundException('User not found');
    return withRoles(user);
  }

  async update(id: bigint, dto: UpdateUserDto, actor: AuthUser) {
    const existing = await this.getExisting(id);
    if (id === actor.id && dto.status && dto.status !== 'ACTIVE') {
      throw new BadRequestException(
        'You cannot suspend or disable your own account',
      );
    }
    await assertContactFree(this.prisma, dto.email, dto.mobile, id);
    const email = dto.email ?? existing.email;
    const mobile = dto.mobile ?? existing.mobile;
    if (!email && !mobile)
      throw new BadRequestException('A user needs an email or a mobile number');

    const blocked = dto.status === 'SUSPENDED' || dto.status === 'DISABLED';
    const user = await this.prisma.users.update({
      where: { id },
      data: {
        full_name: dto.fullName,
        email: dto.email,
        mobile: dto.mobile,
        status: dto.status,
        ...(dto.email && dto.email !== existing.email
          ? { email_verified_at: null }
          : {}),
        ...(dto.mobile && dto.mobile !== existing.mobile
          ? { mobile_verified_at: null }
          : {}),
      },
      select: userDetailSelect,
    });
    if (blocked) await revokeAllSessions(this.prisma, id);
    return withRoles(user);
  }

  /** Replaces the user's roles, creating profile rows for newly granted STUDENT/FACULTY roles. */
  async setRoles(id: bigint, roles: RoleCode[], actor: AuthUser) {
    await this.getExisting(id);
    if (id === actor.id && !roles.includes(RoleCode.ADMIN)) {
      throw new BadRequestException('You cannot remove your own ADMIN role');
    }
    const user = await this.prisma.$transaction(async (tx) => {
      await tx.user_roles.deleteMany({
        where: { user_id: id, roles: { code: { notIn: roles } } },
      });
      const current = await tx.user_roles.findMany({
        where: { user_id: id },
        select: { roles: { select: { code: true } } },
      });
      const have = new Set(current.map((r) => r.roles.code));
      for (const code of roles.filter((r) => !have.has(r))) {
        await tx.user_roles.create({
          data: { users: { connect: { id } }, roles: { connect: { code } } },
        });
      }
      await ensureProfiles(tx, id, roles);
      return tx.users.findUniqueOrThrow({
        where: { id },
        select: userDetailSelect,
      });
    });
    return withRoles(user);
  }

  /** Soft delete: the row stays for history (enrollments, payments...), the user can no longer log in. */
  async remove(id: bigint, actor: AuthUser): Promise<void> {
    if (id === actor.id)
      throw new BadRequestException('You cannot delete your own account');
    await this.getExisting(id);
    await this.prisma.users.update({
      where: { id },
      data: { deleted_at: new Date(), status: 'DISABLED' },
    });
    await revokeAllSessions(this.prisma, id);
  }

  /** Issues a password setup/reset token for the admin to hand to the user (valid 1 hour). */
  async issuePasswordToken(id: bigint) {
    const user = await this.getExisting(id);
    if (user.deleted_at)
      throw new BadRequestException('This user has been deleted');
    return {
      token: await this.tokens.issue(id, 'PASSWORD_RESET'),
      expiresInMinutes: 60,
    };
  }

  private async getExisting(id: bigint) {
    const user = await this.prisma.users.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}

/** student_profiles / faculty_profiles rows are required by FKs (enrollments, batch_faculty...). */
export async function ensureProfiles(
  tx: Tx,
  userId: bigint,
  roles: RoleCode[],
): Promise<void> {
  if (roles.includes(RoleCode.STUDENT)) {
    await tx.student_profiles.upsert({
      where: { user_id: userId },
      update: {},
      create: { user_id: userId },
    });
  }
  if (roles.includes(RoleCode.FACULTY)) {
    await tx.faculty_profiles.upsert({
      where: { user_id: userId },
      update: {},
      create: { user_id: userId },
    });
  }
}
