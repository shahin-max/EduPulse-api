import {
  Body,
  Controller,
  Get,
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
import { ClassesService } from './classes.service.js';
import {
  CreateClassSessionDto,
  ListClassSessionsQueryDto,
  MarkAttendanceDto,
  TimetableQueryDto,
  UpdateClassSessionDto,
} from './dto/classes.dto.js';

@ApiTags('Classes & attendance')
@ApiBearerAuth()
@Controller('class-sessions')
export class ClassSessionsController {
  constructor(private readonly classes: ClassesService) {}

  /** Schedule a class. Admins and faculty assigned to the batch. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Post()
  create(@Body() dto: CreateClassSessionDto, @CurrentUser() user: AuthUser) {
    return this.classes.create(dto, user);
  }

  /** Classes of one batch, optionally within a date range. Batch managers and its active students. */
  @Get()
  list(
    @Query() query: ListClassSessionsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.classes.list(query, user);
  }

  /** Your timetable across all your batches (default: the next 7 days). */
  @Get('timetable')
  timetable(@Query() query: TimetableQueryDto, @CurrentUser() user: AuthUser) {
    return this.classes.timetable(query, user);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.classes.findOne(BigInt(id), user);
  }

  /** Reschedule, change links (e.g. add the recording) or set status. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateClassSessionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.classes.update(BigInt(id), dto, user);
  }

  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Post(':id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.classes.cancel(BigInt(id), user);
  }

  /** Attendance sheet: every student of the batch with their mark (or null). */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Get(':id/attendance')
  attendance(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.classes.attendanceSheet(BigInt(id), user);
  }

  /** Mark attendance for many students at once; re-marking overwrites. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Put(':id/attendance')
  markAttendance(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MarkAttendanceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.classes.markAttendance(BigInt(id), dto, user);
  }
}

@ApiTags('Classes & attendance')
@ApiBearerAuth()
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly classes: ClassesService) {}

  /** Your attendance per batch with present/absent/late/excused counts and percentage. */
  @Roles(RoleCode.STUDENT)
  @Get('me')
  mine(@CurrentUser() user: AuthUser) {
    return this.classes.myAttendance(user);
  }
}
