import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthUser, isAdmin } from '../common/auth.js';
import {
  AdminFacultyProfileDto,
  AdminStudentProfileDto,
} from './dto/user.dto.js';

const publicFacultySelect = {
  user_id: true,
  qualification: true,
  specialization: true,
  biography: true,
  users: { select: { full_name: true } },
} as const;

@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async getStudent(userId: bigint) {
    const profile = await this.prisma.student_profiles.findUnique({
      where: { user_id: userId },
      include: {
        users: {
          select: {
            id: true,
            full_name: true,
            email: true,
            mobile: true,
            status: true,
          },
        },
      },
    });
    if (!profile) throw new NotFoundException('Student not found');
    return profile;
  }

  /** Faculty may only open the profiles of students in batches they teach. */
  async getStudentFor(actor: AuthUser, userId: bigint) {
    if (!isAdmin(actor)) {
      const shared = await this.prisma.enrollments.findFirst({
        where: {
          student_user_id: userId,
          batches: { batch_faculty: { some: { faculty_user_id: actor.id } } },
        },
        select: { id: true },
      });
      if (!shared)
        throw new ForbiddenException(
          'This student is not in any of your batches',
        );
    }
    return this.getStudent(userId);
  }

  async updateStudent(userId: bigint, dto: AdminStudentProfileDto) {
    await this.getStudent(userId);
    await this.prisma.student_profiles.update({
      where: { user_id: userId },
      data: {
        date_of_birth: dto.dateOfBirth,
        grade: dto.grade,
        school_name: dto.schoolName,
        guardian_name: dto.guardianName,
        guardian_mobile: dto.guardianMobile,
        address: dto.address,
        admission_number: dto.admissionNumber,
        joined_on: dto.joinedOn,
      },
    });
    return this.getStudent(userId);
  }

  /** Faculty shown on the website: active, not deleted. */
  listPublicFaculty() {
    return this.prisma.faculty_profiles.findMany({
      where: { users: { status: 'ACTIVE', deleted_at: null } },
      select: publicFacultySelect,
      orderBy: { users: { full_name: 'asc' } },
    });
  }

  async getPublicFaculty(userId: bigint) {
    const profile = await this.prisma.faculty_profiles.findFirst({
      where: { user_id: userId, users: { status: 'ACTIVE', deleted_at: null } },
      select: publicFacultySelect,
    });
    if (!profile) throw new NotFoundException('Faculty member not found');
    return profile;
  }

  async getFaculty(userId: bigint) {
    const profile = await this.prisma.faculty_profiles.findUnique({
      where: { user_id: userId },
      include: {
        users: {
          select: {
            id: true,
            full_name: true,
            email: true,
            mobile: true,
            status: true,
          },
        },
        batch_faculty: {
          select: {
            subjects: { select: { id: true, code: true, name: true } },
            batches: {
              select: { id: true, code: true, name: true, status: true },
            },
          },
        },
      },
    });
    if (!profile) throw new NotFoundException('Faculty member not found');
    return profile;
  }

  async updateFaculty(userId: bigint, dto: AdminFacultyProfileDto) {
    await this.getFaculty(userId);
    await this.prisma.faculty_profiles.update({
      where: { user_id: userId },
      data: {
        qualification: dto.qualification,
        specialization: dto.specialization,
        biography: dto.biography,
        employee_code: dto.employeeCode,
        joined_on: dto.joinedOn,
      },
    });
    return this.getFaculty(userId);
  }
}
