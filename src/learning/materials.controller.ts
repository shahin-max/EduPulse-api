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
import { CurrentUser, RoleCode, Roles, SkipAudit } from '../common/auth.js';
import { MaterialsService } from './materials.service.js';
import {
  BatchProgressQueryDto,
  CreateStudyMaterialDto,
  ListStudyMaterialsQueryDto,
  UpdateProgressDto,
  UpdateStudyMaterialDto,
} from './dto/learning.dto.js';

@ApiTags('Study materials')
@ApiBearerAuth()
@Controller('study-materials')
export class MaterialsController {
  constructor(private readonly materials: MaterialsService) {}

  /** Materials of a chapter. Staff see all; enrolled students see published ones. */
  @Get()
  list(
    @Query() query: ListStudyMaterialsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.materials.listForChapter(BigInt(query.chapterId), user);
  }

  /** The logged-in student's progress on materials. */
  @Roles(RoleCode.STUDENT)
  @Get('progress/me')
  myProgress(@CurrentUser() user: AuthUser) {
    return this.materials.myProgress(user);
  }

  /** Progress of the students in a batch. Admins and the batch's faculty. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Get('progress')
  batchProgress(
    @Query() query: BatchProgressQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.materials.batchProgress(query, user);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.materials.findOne(BigInt(id), user);
  }

  /** Add a note, worksheet, previous paper or video link to a chapter. Needs assetId or externalUrl. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Post()
  create(@Body() dto: CreateStudyMaterialDto, @CurrentUser() user: AuthUser) {
    return this.materials.create(dto, user);
  }

  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStudyMaterialDto,
  ) {
    return this.materials.update(BigInt(id), dto);
  }

  /** Deletes the material and its progress records (not the uploaded file). */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.materials.remove(BigInt(id));
  }

  /** Record your progress (NOT_STARTED, IN_PROGRESS, COMPLETED) on a material. */
  @Roles(RoleCode.STUDENT)
  @SkipAudit()
  @Put(':id/progress')
  progress(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProgressDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.materials.updateProgress(BigInt(id), dto.status, user);
  }
}
