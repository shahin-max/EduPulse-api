import { Controller, Get, Module, Param, ParseIntPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../common/auth.js';
import { CurrentUser, RoleCode, Roles } from '../common/auth.js';
import { ReportsService } from './reports.service.js';

@ApiTags('Teaching reports')
@ApiBearerAuth()
@Roles(RoleCode.ADMIN, RoleCode.FACULTY)
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /**
   * Work waiting for you in the batches you teach (admins: all batches): submissions to review,
   * classes without attendance, assignments due this week, upcoming exams, your enquiries.
   */
  @Get('teaching/dashboard')
  dashboard(@CurrentUser() user: AuthUser) {
    return this.reports.dashboard(user);
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
