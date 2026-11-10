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
import {
  CurrentUser,
  isStaff,
  Public,
  RoleCode,
  Roles,
} from '../common/auth.js';
import { CatalogService } from './catalog.service.js';
import {
  AttachSubjectDto,
  CreateChapterDto,
  CreateCourseDto,
  CreateSubjectDto,
  ListCoursesQueryDto,
  UpdateChapterDto,
  UpdateCourseDto,
  UpdateSubjectDto,
} from './dto/catalog.dto.js';

@ApiTags('Subjects')
@Controller('subjects')
export class SubjectsController {
  constructor(private readonly catalog: CatalogService) {}

  @Public()
  @Get()
  list() {
    return this.catalog.listSubjects();
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @Post()
  create(@Body() dto: CreateSubjectDto) {
    return this.catalog.createSubject(dto);
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSubjectDto) {
    return this.catalog.updateSubject(BigInt(id), dto);
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.catalog.removeSubject(BigInt(id));
  }
}

@ApiTags('Courses')
@Controller('courses')
export class CoursesController {
  constructor(private readonly catalog: CatalogService) {}

  /** Published courses with their subjects. Staff can pass includeAll=true. */
  @Public()
  @Get()
  list(@Query() query: ListCoursesQueryDto, @CurrentUser() user?: AuthUser) {
    return this.catalog.listCourses(!!query.includeAll && isStaff(user));
  }

  /** One course by numeric id or slug (e.g. "jee"). */
  @Public()
  @Get(':idOrSlug')
  findOne(@Param('idOrSlug') idOrSlug: string, @CurrentUser() user?: AuthUser) {
    return this.catalog.getCourse(idOrSlug, isStaff(user));
  }

  /** Syllabus: the course's subjects, each with its chapters. */
  @Public()
  @Get(':idOrSlug/curriculum')
  curriculum(
    @Param('idOrSlug') idOrSlug: string,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.catalog.curriculum(idOrSlug, isStaff(user));
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @Post()
  create(@Body() dto: CreateCourseDto, @CurrentUser() user: AuthUser) {
    return this.catalog.createCourse(dto, user.id);
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateCourseDto) {
    return this.catalog.updateCourse(BigInt(id), dto);
  }

  /** Delete a course nothing depends on. Otherwise set status to ARCHIVED. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.catalog.removeCourse(BigInt(id));
  }

  /** Add a subject to the course (or change its position). */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @Put(':id/subjects/:subjectId')
  attachSubject(
    @Param('id', ParseIntPipe) id: number,
    @Param('subjectId', ParseIntPipe) subjectId: number,
    @Body() dto: AttachSubjectDto,
  ) {
    return this.catalog.attachSubject(
      BigInt(id),
      BigInt(subjectId),
      dto.sortOrder,
    );
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id/subjects/:subjectId')
  detachSubject(
    @Param('id', ParseIntPipe) id: number,
    @Param('subjectId', ParseIntPipe) subjectId: number,
  ) {
    return this.catalog.detachSubject(BigInt(id), BigInt(subjectId));
  }
}

@ApiTags('Chapters')
@Controller('chapters')
export class ChaptersController {
  constructor(private readonly catalog: CatalogService) {}

  /** Admins and faculty author chapters. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Post()
  create(@Body() dto: CreateChapterDto) {
    return this.catalog.createChapter(dto);
  }

  @Public()
  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user?: AuthUser,
  ) {
    return this.catalog.getChapter(BigInt(id), isStaff(user));
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateChapterDto) {
    return this.catalog.updateChapter(BigInt(id), dto);
  }

  /** 409 while study materials or questions belong to the chapter. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.catalog.removeChapter(BigInt(id));
  }
}
