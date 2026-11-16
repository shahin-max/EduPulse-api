import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../common/auth.js';
import { CurrentUser, Public, RoleCode, Roles } from '../common/auth.js';
import { ScholarshipsService } from './scholarships.service.js';
import {
  CreateScholarshipTestDto,
  JoinScholarshipTestDto,
  OverrideAwardDto,
  UpdateScholarshipTestDto,
} from './scholarships.dto.js';

@ApiTags('Scholarship tests')
@Controller()
export class ScholarshipsController {
  constructor(private readonly scholarships: ScholarshipsService) {}

  /** The test currently taking registrations (for the website), or null. */
  @Public()
  @Get('scholarship-tests/current')
  current() {
    return this.scholarships.current();
  }

  /** Register for a test (logged-in student). Repeat calls are harmless. */
  @ApiBearerAuth()
  @Roles(RoleCode.STUDENT)
  @HttpCode(HttpStatus.OK)
  @Post('scholarship-tests/:id/join')
  join(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: JoinScholarshipTestDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.scholarships.join(BigInt(id), dto, user);
  }

  /** Your Scholarship Tests: when to take them, your attempt and, once published, your award. */
  @ApiBearerAuth()
  @Roles(RoleCode.STUDENT)
  @Get('student/scholarships')
  mine(@CurrentUser() user: AuthUser) {
    return this.scholarships.mine(user);
  }

  // ---- Admin ----

  /** Creates the test with its candidates batch and a draft exam; build the paper in the exam builder. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @Post('scholarship-tests')
  create(@Body() dto: CreateScholarshipTestDto, @CurrentUser() user: AuthUser) {
    return this.scholarships.create(dto, user);
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @Get('scholarship-tests')
  list() {
    return this.scholarships.list();
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @Get('scholarship-tests/:id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.scholarships.findOne(BigInt(id));
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @Patch('scholarship-tests/:id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateScholarshipTestDto,
  ) {
    return this.scholarships.update(BigInt(id), dto);
  }

  /** Opens registration and publishes the exam (needs questions). */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('scholarship-tests/:id/open')
  open(@Param('id', ParseIntPipe) id: number) {
    return this.scholarships.open(BigInt(id));
  }

  /** Candidates ranked by their best graded attempt, with the slab each earns or its override. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @Get('scholarship-tests/:id/results')
  results(@Param('id', ParseIntPipe) id: number) {
    return this.scholarships.results(BigInt(id));
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @Put('scholarship-tests/:id/awards/:studentUserId')
  override(
    @Param('id', ParseIntPipe) id: number,
    @Param('studentUserId', ParseIntPipe) studentUserId: number,
    @Body() dto: OverrideAwardDto,
  ) {
    return this.scholarships.override(BigInt(id), BigInt(studentUserId), dto);
  }

  /** Stores the awards, releases the results to candidates and notifies them. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @HttpCode(HttpStatus.OK)
  @Post('scholarship-tests/:id/publish')
  publish(@Param('id', ParseIntPipe) id: number) {
    return this.scholarships.publish(BigInt(id));
  }

  /** Scholarships a student can still use on a fee invoice. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @Get('students/:userId/scholarships')
  available(@Param('userId', ParseIntPipe) userId: number) {
    return this.scholarships.availableAwards(BigInt(userId));
  }
}

@Module({
  controllers: [ScholarshipsController],
  providers: [ScholarshipsService],
})
export class ScholarshipsModule {}
