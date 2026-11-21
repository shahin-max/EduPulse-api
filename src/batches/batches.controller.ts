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
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../common/auth.js';
import {
  BRANCH_ADMIN,
  CurrentUser,
  Public,
  RoleCode,
  Roles,
} from '../common/auth.js';
import { BatchesService } from './batches.service.js';
import { EnrollmentsService } from './enrollments.service.js';
import {
  AssignFacultyDto,
  CreateBatchDto,
  CreateEnrollmentDto,
  ListBatchesQueryDto,
  ListEnrollmentsQueryDto,
  UpdateBatchDto,
  UpdateEnrollmentDto,
} from './dto/batch.dto.js';

@ApiTags('Batches')
@Controller('batches')
export class BatchesController {
  constructor(private readonly batches: BatchesService) {}

  /** Open batches of published courses with seats available. Staff see all; `mine=true` lists your own. */
  @Public()
  @Get()
  findAll(@Query() query: ListBatchesQueryDto, @CurrentUser() user?: AuthUser) {
    return this.batches.findAll(query, user);
  }

  @Public()
  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.batches.findOne(BigInt(id), user);
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Post()
  create(@Body() dto: CreateBatchDto, @CurrentUser() user: AuthUser) {
    return this.batches.create(dto, user);
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBatchDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.batches.update(BigInt(id), dto, user);
  }

  /** Delete an unused batch. Batches with enrollments or content: set status CANCELLED instead. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.batches.remove(BigInt(id), user);
  }

  /** Assign a faculty member to teach one of the course's subjects in this batch. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Post(':id/faculty')
  assignFaculty(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignFacultyDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.batches.assignFaculty(BigInt(id), dto, user);
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id/faculty/:facultyUserId/subjects/:subjectId')
  unassignFaculty(
    @Param('id', ParseIntPipe) id: number,
    @Param('facultyUserId', ParseIntPipe) facultyUserId: number,
    @Param('subjectId', ParseIntPipe) subjectId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.batches.unassignFaculty(
      BigInt(id),
      BigInt(facultyUserId),
      BigInt(subjectId),
      user,
    );
  }

  /** Students in the batch. Admins of its branch and the batch's own faculty only. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN, RoleCode.FACULTY)
  @Get(':id/students')
  roster(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.batches.roster(BigInt(id), user);
  }
}

@ApiTags('Enrollments')
@ApiBearerAuth()
@Controller('enrollments')
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  /** Enrol a student in a batch. 409 when the batch is full or the student is already enrolled. */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Post()
  create(@Body() dto: CreateEnrollmentDto, @CurrentUser() user: AuthUser) {
    return this.enrollments.create(dto, user);
  }

  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Get()
  findAll(
    @Query() query: ListEnrollmentsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.enrollments.findAll(query, user);
  }

  /** The logged-in student's enrollments. */
  @Roles(RoleCode.STUDENT)
  @Get('me')
  mine(@CurrentUser() user: AuthUser) {
    return this.enrollments.findForStudent(user.id);
  }

  /** Change status (PENDING, ACTIVE, PAUSED, COMPLETED, CANCELLED) or the access window. */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEnrollmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.enrollments.update(BigInt(id), dto, user);
  }
}
