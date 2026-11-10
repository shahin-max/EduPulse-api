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
import { CurrentUser, Public, RoleCode, Roles } from '../common/auth.js';
import { StudentSelfProfileDto } from '../auth/dto/auth.dto.js';
import { UsersService } from './users.service.js';
import { ProfilesService } from './profiles.service.js';
import {
  AdminFacultyProfileDto,
  AdminStudentProfileDto,
  CreateUserDto,
  FacultySelfProfileDto,
  ListUsersQueryDto,
  SetRolesDto,
  UpdateUserDto,
} from './dto/user.dto.js';

@ApiTags('Users')
@ApiBearerAuth()
@Roles(RoleCode.ADMIN)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** Create an account with one or more roles. Without a password the response includes a `setupToken`. */
  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Get()
  findAll(@Query() query: ListUsersQueryDto) {
    return this.users.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.users.findOne(BigInt(id));
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.users.update(BigInt(id), dto, actor);
  }

  /** Replace the user's roles. Granting STUDENT or FACULTY creates the profile row. */
  @Put(':id/roles')
  setRoles(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetRolesDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.users.setRoles(BigInt(id), dto.roles, actor);
  }

  /** Soft-delete: blocks login and keeps the history. */
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.users.remove(BigInt(id), actor);
  }

  /** Issue a one-hour token the user can use at POST /auth/password/reset (e.g. forgotten password). */
  @Post(':id/password-token')
  passwordToken(@Param('id', ParseIntPipe) id: number) {
    return this.users.issuePasswordToken(BigInt(id));
  }
}

@ApiTags('Students')
@ApiBearerAuth()
@Controller('students')
export class StudentsController {
  constructor(private readonly profiles: ProfilesService) {}

  /** Your own student profile. */
  @Roles(RoleCode.STUDENT)
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.profiles.getStudent(user.id);
  }

  /** Update your date of birth, grade, school, guardian and address. */
  @Roles(RoleCode.STUDENT)
  @Patch('me')
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: StudentSelfProfileDto) {
    return this.profiles.updateStudent(user.id, dto);
  }

  /** A student's profile. Faculty can only see students in their own batches. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Get(':userId')
  findOne(
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.profiles.getStudentFor(actor, BigInt(userId));
  }

  /** Update any student profile field, including admission number and joining date. */
  @Roles(RoleCode.ADMIN)
  @Patch(':userId')
  update(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: AdminStudentProfileDto,
  ) {
    return this.profiles.updateStudent(BigInt(userId), dto);
  }
}

@ApiTags('Faculty')
@Controller('faculty')
export class FacultyController {
  constructor(private readonly profiles: ProfilesService) {}

  /** Faculty shown on the website (name, qualification, specialization, biography). */
  @Public()
  @Get()
  list() {
    return this.profiles.listPublicFaculty();
  }

  /** Your own faculty profile with the batches and subjects you teach. */
  @ApiBearerAuth()
  @Roles(RoleCode.FACULTY)
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.profiles.getFaculty(user.id);
  }

  @ApiBearerAuth()
  @Roles(RoleCode.FACULTY)
  @Patch('me')
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: FacultySelfProfileDto) {
    return this.profiles.updateFaculty(user.id, dto);
  }

  @Public()
  @Get(':userId')
  findOne(@Param('userId', ParseIntPipe) userId: number) {
    return this.profiles.getPublicFaculty(BigInt(userId));
  }

  /** Update any faculty profile field, including employee code and joining date. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @Patch(':userId')
  update(
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: AdminFacultyProfileDto,
  ) {
    return this.profiles.updateFaculty(BigInt(userId), dto);
  }
}
