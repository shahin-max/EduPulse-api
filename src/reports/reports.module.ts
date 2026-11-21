import {
  Controller,
  Get,
  Module,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { csvFile } from '../common/csv.js';
import type { AuthUser } from '../common/auth.js';
import { BRANCH_ADMIN, CurrentUser, RoleCode, Roles } from '../common/auth.js';
import { AccessService } from '../common/access.service.js';
import { ReportsService } from './reports.service.js';

@ApiTags('Teaching reports')
@ApiBearerAuth()
@Roles(RoleCode.ADMIN, BRANCH_ADMIN, RoleCode.FACULTY)
@Controller()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly access: AccessService,
  ) {}

  /**
   * Work waiting for you in the batches you teach (admins: all batches): submissions to review,
   * classes without attendance, assignments due this week, upcoming exams, your enquiries.
   */
  @Get('teaching/dashboard')
  dashboard(@CurrentUser() user: AuthUser) {
    return this.reports.dashboard(user);
  }

  /**
   * Admin home charts: fee collections, new enrollments and enquiries (with conversions) for the
   * last 6 months, and attendance per active batch. Head office: every branch, or one with
   * `branchId`; branch admins: their branches.
   */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @ApiQuery({ name: 'branchId', required: false, type: Number })
  @Get('reports/admin-summary')
  adminSummary(
    @CurrentUser() user: AuthUser,
    @Query('branchId', new ParseIntPipe({ optional: true })) branchId?: number,
  ) {
    return this.reports.adminSummary(this.access.branchScope(user, branchId));
  }

  /**
   * The batch gradebook: every student (active, paused or completed enrollment) with attendance,
   * each published assignment, each exam (best graded attempt) and study materials completed.
   */
  @Get('batches/:id/gradebook')
  gradebook(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reports.gradebook(BigInt(id), user);
  }

  /** One student's progress in the batch: attendance by class, assignments, exam attempts, materials. */
  /** The gradebook as a CSV download: one row per student, one column per assignment and test. */
  @ApiProduces('text/csv')
  @Get('batches/:id/gradebook/export')
  async gradebookCsv(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    const book = await this.reports.gradebook(BigInt(id), user);
    // Marks and percentages are Prisma Decimals (or null).
    type Cell = {
      state?: string;
      marks?: { toString(): string } | null;
      percentage?: { toString(): string } | null;
    };
    const headers = [
      'Student',
      'Admission no',
      'Enrollment',
      'Attendance %',
      'Present',
      'Late',
      'Absent',
      ...book.assignments.map(
        (a) => `${a.title}${a.max_marks ? ` (/${String(a.max_marks)})` : ''}`,
      ),
      ...book.exams.map((e) => `${e.title} (best %)`),
      `Materials done (of ${book.materials_total})`,
    ];
    const rows = book.students.map((s) => [
      s.full_name,
      s.admission_number,
      s.enrollment_status,
      s.attendance.percentage,
      s.attendance.present,
      s.attendance.late,
      s.attendance.absent,
      ...book.assignments.map((a) => {
        const cell = s.assignments[String(a.id)] as Cell | undefined;
        return cell?.marks != null ? cell.marks.toString() : (cell?.state ?? '');
      }),
      ...book.exams.map((e) => {
        const cell = s.exams[String(e.id)] as Cell | undefined;
        return cell?.percentage != null ? cell.percentage.toString() : '';
      }),
      s.materials_completed,
    ]);
    return csvFile(`gradebook-${book.batch.code}`, headers, rows);
  }

  @Get('batches/:id/students/:userId/report')
  studentReport(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.reports.studentReport(BigInt(id), BigInt(userId), user);
  }
}

@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
