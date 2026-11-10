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
import { QuestionsService } from './questions.service.js';
import { ExamsService } from './exams.service.js';
import { AttemptsService } from './attempts.service.js';
import {
  AddExamQuestionDto,
  CreateExamDto,
  CreateQuestionDto,
  LeaderboardQueryDto,
  ListAttemptsQueryDto,
  ListExamsQueryDto,
  ListQuestionsQueryDto,
  MyAttemptsQueryDto,
  ReorderExamQuestionsDto,
  SaveAnswerDto,
  StartAttemptDto,
  UpdateExamDto,
  UpdateExamQuestionDto,
  UpdateQuestionDto,
} from './dto/exams.dto.js';

@ApiTags('Question bank')
@ApiBearerAuth()
@Roles(RoleCode.ADMIN, RoleCode.FACULTY)
@Controller('questions')
export class QuestionsController {
  constructor(private readonly questions: QuestionsService) {}

  /** Questions with options (including the correct one). Filter by course, subject, chapter, difficulty. */
  @Get()
  findAll(@Query() query: ListQuestionsQueryDto) {
    return this.questions.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.questions.findOne(BigInt(id));
  }

  /** Single-choice question with 2-8 options, exactly one correct. */
  @Post()
  create(@Body() dto: CreateQuestionDto, @CurrentUser() user: AuthUser) {
    return this.questions.create(dto, user);
  }

  /** Faculty can edit their own questions. Options are locked once the question appears in an attempt. */
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateQuestionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.questions.update(BigInt(id), dto, user);
  }

  /** Delete a question that is not in any exam; otherwise deactivate it. */
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.questions.remove(BigInt(id), user);
  }
}

@ApiTags('Exams')
@ApiBearerAuth()
@Controller('exams')
export class ExamsController {
  constructor(
    private readonly exams: ExamsService,
    private readonly attempts: AttemptsService,
  ) {}

  /** Admins see all exams; faculty see exams they created or that are attached to their batches. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Get()
  findAll(@Query() query: ListExamsQueryDto, @CurrentUser() user: AuthUser) {
    return this.exams.findAll(query, user);
  }

  /** Published, not-yet-closed exams for your batches, with attempts left and any attempt in progress. */
  @Roles(RoleCode.STUDENT)
  @Get('available')
  available(@CurrentUser() user: AuthUser) {
    return this.attempts.available(user);
  }

  /** Staff get questions and answers; students get exam details and their attempt count. */
  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exams.findOne(BigInt(id), user);
  }

  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Post()
  create(@Body() dto: CreateExamDto, @CurrentUser() user: AuthUser) {
    return this.exams.create(dto, user);
  }

  /** Change settings or status (DRAFT, PUBLISHED, CLOSED). */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateExamDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exams.update(BigInt(id), dto, user);
  }

  /** Delete an exam nobody has attempted. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.exams.remove(BigInt(id), user);
  }

  /** Make the exam available to a batch of the same course. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Put(':id/batches/:batchId')
  attachBatch(
    @Param('id', ParseIntPipe) id: number,
    @Param('batchId', ParseIntPipe) batchId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exams.attachBatch(BigInt(id), BigInt(batchId), user);
  }

  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id/batches/:batchId')
  detachBatch(
    @Param('id', ParseIntPipe) id: number,
    @Param('batchId', ParseIntPipe) batchId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exams.detachBatch(BigInt(id), BigInt(batchId), user);
  }

  /** Add a question; marks default to the question's, negative marks to the exam's. Recomputes total marks. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Post(':id/questions')
  addQuestion(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddExamQuestionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exams.addQuestion(BigInt(id), dto, user);
  }

  /** Set the order of all the exam's questions. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Put(':id/questions/order')
  reorder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReorderExamQuestionsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exams.reorderQuestions(BigInt(id), dto.questionIds, user);
  }

  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Patch(':id/questions/:questionId')
  updateQuestion(
    @Param('id', ParseIntPipe) id: number,
    @Param('questionId', ParseIntPipe) questionId: number,
    @Body() dto: UpdateExamQuestionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exams.updateQuestion(BigInt(id), BigInt(questionId), dto, user);
  }

  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id/questions/:questionId')
  removeQuestion(
    @Param('id', ParseIntPipe) id: number,
    @Param('questionId', ParseIntPipe) questionId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exams.removeQuestion(BigInt(id), BigInt(questionId), user);
  }

  /** All attempts of the exam (scores included). */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Get(':id/attempts')
  listAttempts(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: ListAttemptsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exams.listAttempts(BigInt(id), query, user);
  }

  /** Start an attempt. Returns the questions (without answers) and the deadline. */
  @Roles(RoleCode.STUDENT)
  @Post(':id/attempts')
  start(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: StartAttemptDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.attempts.start(BigInt(id), user, dto.batchId);
  }

  /** Ranking by the exam's attempt policy. Students can see it once results are released. */
  @Get(':id/leaderboard')
  leaderboard(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: LeaderboardQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exams.leaderboard(BigInt(id), query, user);
  }
}

@ApiTags('Exam attempts')
@ApiBearerAuth()
@Controller('exam-attempts')
export class AttemptsController {
  constructor(
    private readonly attempts: AttemptsService,
    private readonly exams: ExamsService,
  ) {}

  /** Your attempts, optionally for one exam. Scores appear once results are released. */
  @Roles(RoleCode.STUDENT)
  @Get('me')
  mine(@Query() query: MyAttemptsQueryDto, @CurrentUser() user: AuthUser) {
    return this.attempts.mine(user, query.examId);
  }

  /** An attempt with its questions. Answers and explanations appear after the review release time. */
  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.attempts.get(BigInt(id), user);
  }

  /** Save or clear an answer, or flag it for review, while the attempt is running. */
  @SkipAudit()
  @Roles(RoleCode.STUDENT)
  @Put(':id/answers/:questionId')
  saveAnswer(
    @Param('id', ParseIntPipe) id: number,
    @Param('questionId', ParseIntPipe) questionId: number,
    @Body() dto: SaveAnswerDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.attempts.saveAnswer(BigInt(id), BigInt(questionId), dto, user);
  }

  /** Submit and grade the attempt. */
  @Roles(RoleCode.STUDENT)
  @HttpCode(HttpStatus.OK)
  @Post(':id/submit')
  submit(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.attempts.submit(BigInt(id), user);
  }

  /** Void an attempt (e.g. malpractice). It no longer counts towards limits or rankings. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @HttpCode(HttpStatus.OK)
  @Post(':id/invalidate')
  invalidate(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.exams.invalidateAttempt(BigInt(id), user);
  }
}
