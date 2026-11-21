import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  ParseBoolPipe,
  ParseEnumPipe,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../common/auth.js';
import {
  BRANCH_ADMIN,
  CurrentUser,
  Public,
  RoleCode,
  Roles,
} from '../common/auth.js';
import { BranchesService } from './branches.service.js';
import {
  AddBranchStaffDto,
  BRANCH_STAFF_ROLES,
  type BranchStaffRole,
  CreateBranchDto,
  UpdateBranchDto,
} from './dto/branch.dto.js';

@ApiTags('Branches')
@ApiBearerAuth()
@Controller('branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  /**
   * Branches with their batch and staff counts (branch admins: their own branches only).
   * Inactive branches only with includeInactive=true.
   */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN, RoleCode.FACULTY)
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('includeInactive', new ParseBoolPipe({ optional: true }))
    includeInactive?: boolean,
  ) {
    return this.branches.list(includeInactive ?? false, user);
  }

  /** Active branches for the website (enquiry form, contact page): name, city and phone only. */
  @Public()
  @Get('public')
  publicList() {
    return this.branches.publicList();
  }

  @Roles(RoleCode.ADMIN, BRANCH_ADMIN, RoleCode.FACULTY)
  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.branches.findOne(BigInt(id), user);
  }

  @Roles(RoleCode.ADMIN)
  @Post()
  create(@Body() dto: CreateBranchDto) {
    return this.branches.create(dto);
  }

  /** Branches are never deleted (batches, invoices and payments point at them); set isActive=false instead. */
  @Roles(RoleCode.ADMIN)
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateBranchDto) {
    return this.branches.update(BigInt(id), dto);
  }

  /** The branch's admins and faculty. */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Get(':id/staff')
  staff(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.branches.listStaff(BigInt(id), user);
  }

  /**
   * Add a branch admin (head office only) or a faculty member (head office, or the branch's own
   * admins). A branch admin signs in on the normal login page and sees only this branch.
   */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @Post(':id/staff')
  addStaff(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddBranchStaffDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.branches.addStaff(BigInt(id), dto, user);
  }

  /** Remove someone from the branch staff. Removing a branch admin ends their access at once. */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id/staff/:userId/:role')
  removeStaff(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Param('role', new ParseEnumPipe(BRANCH_STAFF_ROLES)) role: BranchStaffRole,
    @CurrentUser() user: AuthUser,
  ) {
    return this.branches.removeStaff(BigInt(id), BigInt(userId), role, user);
  }

  /** Courses offered at the branch. */
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN, RoleCode.FACULTY)
  @Get(':id/courses')
  courses(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.branches.listCourses(BigInt(id), user);
  }

  /** Head office: offer a course at the branch, so its admins can open batches for it. */
  @Roles(RoleCode.ADMIN)
  @Put(':id/courses/:courseId')
  offerCourse(
    @Param('id', ParseIntPipe) id: number,
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.branches.offerCourse(BigInt(id), BigInt(courseId), user);
  }

  /** Head office: stop offering a course at the branch (running batches are not affected). */
  @Roles(RoleCode.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id/courses/:courseId')
  withdrawCourse(
    @Param('id', ParseIntPipe) id: number,
    @Param('courseId', ParseIntPipe) courseId: number,
  ) {
    return this.branches.withdrawCourse(BigInt(id), BigInt(courseId));
  }
}

@Module({
  controllers: [BranchesController],
  providers: [BranchesService],
  exports: [BranchesService],
})
export class BranchesModule {}
