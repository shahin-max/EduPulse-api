import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../common/auth.js';
import { CurrentUser, RoleCode, Roles } from '../common/auth.js';
import { AssignmentsService } from './assignments.service.js';
import {
  CreateAssignmentDto,
  ListAssignmentsQueryDto,
  ReviewSubmissionDto,
  SubmitAssignmentDto,
  UpdateAssignmentDto,
} from './dto/learning.dto.js';

@ApiTags('Assignments')
@ApiBearerAuth()
@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  /** Create an assignment for a batch. Admins and the batch's faculty. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Post()
  create(@Body() dto: CreateAssignmentDto, @CurrentUser() user: AuthUser) {
    return this.assignments.create(dto, user);
  }

  /** Assignments of a batch. Students see PUBLISHED/CLOSED ones with `my_submission`. */
  @Get()
  list(@Query() query: ListAssignmentsQueryDto, @CurrentUser() user: AuthUser) {
    return this.assignments.list(query.batchId, user);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignments.findOne(BigInt(id), user);
  }

  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAssignmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignments.update(BigInt(id), dto, user);
  }

  /** Delete an assignment with no submissions; otherwise set status CLOSED. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.assignments.remove(BigInt(id), user);
  }

  /**
   * Submit or resubmit your work (text and/or a file you uploaded). Late work is accepted
   * and flagged `is_late` until the assignment is CLOSED; resubmission stops once reviewed.
   */
  @Roles(RoleCode.STUDENT)
  @Put(':id/submission')
  submit(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SubmitAssignmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignments.submit(BigInt(id), dto, user);
  }

  /** Your submission, with marks and feedback once reviewed. */
  @Roles(RoleCode.STUDENT)
  @Get(':id/submission')
  mySubmission(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignments.mySubmission(BigInt(id), user);
  }

  /** All submissions for the assignment. Admins and the batch's faculty. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Get(':id/submissions')
  submissions(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignments.listSubmissions(BigInt(id), user);
  }
}

@ApiTags('Assignments')
@ApiBearerAuth()
@Controller('assignment-submissions')
export class SubmissionsController {
  constructor(private readonly assignments: AssignmentsService) {}

  /** Record marks and/or feedback. Marks cannot exceed the assignment's maxMarks. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Patch(':id/review')
  review(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewSubmissionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.assignments.review(BigInt(id), dto, user);
  }
}
