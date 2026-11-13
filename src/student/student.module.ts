import { Controller, Get, Module, Param, ParseIntPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../common/auth.js';
import { CurrentUser, RoleCode, Roles } from '../common/auth.js';
import { StudentService } from './student.service.js';

@ApiTags('Student portal')
@ApiBearerAuth()
@Roles(RoleCode.STUDENT)
@Controller('student')
export class StudentController {
  constructor(private readonly student: StudentService) {}

  /** Your current batches (active enrollments) with teachers and study-material progress. */
  @Get('courses')
  courses(@CurrentUser() user: AuthUser) {
    return this.student.courses(user);
  }

  /**
   * Assignments in all your current batches, oldest due first, each with your submission and a
   * `state`: MISSING, NOT_DUE, SUBMITTED, LATE or REVIEWED.
   */
  @Get('assignments')
  assignments(@CurrentUser() user: AuthUser) {
    return this.student.assignments(user);
  }

  /** A course's published chapters and materials with your progress on each. */
  @Get('courses/:courseId/materials')
  courseMaterials(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.student.courseMaterials(user, BigInt(courseId));
  }
}

@Module({ controllers: [StudentController], providers: [StudentService] })
export class StudentModule {}
