import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthUser, isAdmin } from '../common/auth.js';
import { paginated, skipTake } from '../common/pagination.js';
import { toDecimal } from './exam-rules.js';
import {
  CreateQuestionDto,
  ListQuestionsQueryDto,
  QuestionOptionDto,
  UpdateQuestionDto,
} from './dto/exams.dto.js';

export const questionInclude = {
  question_options: {
    orderBy: [{ sort_order: 'asc' }, { option_label: 'asc' }],
  },
  course_subjects: {
    select: {
      id: true,
      courses: { select: { id: true, code: true, title: true } },
      subjects: { select: { id: true, code: true, name: true } },
    },
  },
  chapters: { select: { id: true, title: true } },
} satisfies Prisma.questionsInclude;

/** SINGLE_CHOICE rules: unique labels and exactly one correct option. */
export function assertOptions(options: QuestionOptionDto[]): void {
  const labels = new Set(options.map((o) => o.optionLabel));
  if (labels.size !== options.length)
    throw new BadRequestException('option labels must be unique');
  const correct = options.filter((o) => o.isCorrect).length;
  if (correct !== 1)
    throw new BadRequestException(
      'a single-choice question needs exactly one correct option',
    );
}

function optionRows(options: QuestionOptionDto[]) {
  return options.map((o, index) => ({
    option_label: o.optionLabel,
    option_text: o.optionText,
    is_correct: o.isCorrect,
    sort_order: o.sortOrder ?? index,
  }));
}

@Injectable()
export class QuestionsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: ListQuestionsQueryDto) {
    const where: Prisma.questionsWhereInput = {
      course_subject_id:
        query.courseSubjectId === undefined
          ? undefined
          : BigInt(query.courseSubjectId),
      chapter_id:
        query.chapterId === undefined ? undefined : BigInt(query.chapterId),
      difficulty: query.difficulty,
      is_active: query.isActive,
      ...(query.courseId !== undefined || query.subjectId !== undefined
        ? {
            course_subjects: {
              course_id:
                query.courseId === undefined
                  ? undefined
                  : BigInt(query.courseId),
              subject_id:
                query.subjectId === undefined
                  ? undefined
                  : BigInt(query.subjectId),
            },
          }
        : {}),
      ...(query.search ? { question_text: { contains: query.search } } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.questions.findMany({
        where,
        include: questionInclude,
        orderBy: { id: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.questions.count({ where }),
    ]);
    return paginated(data, total, query);
  }

  async findOne(id: bigint) {
    const question = await this.prisma.questions.findUnique({
      where: { id },
      include: questionInclude,
    });
    if (!question) throw new NotFoundException('Question not found');
    return question;
  }

  async create(dto: CreateQuestionDto, actor: AuthUser) {
    assertOptions(dto.options);
    const courseSubjectId = await this.resolveCourseSubject(dto);
    const chapterId = await this.resolveChapter(courseSubjectId, dto.chapterId);
    return this.prisma.questions.create({
      data: {
        course_subject_id: courseSubjectId,
        chapter_id: chapterId,
        question_text: dto.questionText,
        explanation: dto.explanation,
        difficulty: dto.difficulty,
        marks_default:
          dto.marksDefault === undefined
            ? undefined
            : toDecimal(dto.marksDefault),
        is_active: dto.isActive,
        created_by: actor.id,
        question_options: { create: optionRows(dto.options) },
      },
      include: questionInclude,
    });
  }

  async update(id: bigint, dto: UpdateQuestionDto, actor: AuthUser) {
    const question = await this.findEditable(id, actor);
    if (dto.options) {
      assertOptions(dto.options);
      const used = await this.prisma.attempt_answers.count({
        where: { question_id: id },
      });
      if (used) {
        throw new ConflictException(
          'This question has been used in exam attempts, so its options cannot change. Deactivate it and create a new one.',
        );
      }
    }
    const chapterId =
      dto.chapterId === undefined
        ? undefined
        : await this.resolveChapter(question.course_subject_id, dto.chapterId);
    return this.prisma.$transaction(async (tx) => {
      if (dto.options) {
        await tx.question_options.deleteMany({ where: { question_id: id } });
        await tx.question_options.createMany({
          data: optionRows(dto.options).map((o) => ({ ...o, question_id: id })),
        });
      }
      return tx.questions.update({
        where: { id },
        data: {
          chapter_id: chapterId,
          question_text: dto.questionText,
          explanation: dto.explanation,
          difficulty: dto.difficulty,
          marks_default:
            dto.marksDefault === undefined
              ? undefined
              : toDecimal(dto.marksDefault),
          is_active: dto.isActive,
        },
        include: questionInclude,
      });
    });
  }

  /** Only questions not used by any exam can be deleted; otherwise deactivate them. */
  async remove(id: bigint, actor: AuthUser): Promise<void> {
    await this.findEditable(id, actor);
    const inExams = await this.prisma.exam_questions.count({
      where: { question_id: id },
    });
    if (inExams)
      throw new ConflictException(
        'This question is part of an exam. Remove it from the exam or deactivate it.',
      );
    await this.prisma.$transaction([
      this.prisma.question_options.deleteMany({ where: { question_id: id } }),
      this.prisma.questions.delete({ where: { id } }),
    ]);
  }

  /** Admins edit any question; faculty edit the questions they wrote. */
  private async findEditable(id: bigint, actor: AuthUser) {
    const question = await this.prisma.questions.findUnique({ where: { id } });
    if (!question) throw new NotFoundException('Question not found');
    if (!isAdmin(actor) && question.created_by !== actor.id) {
      throw new ForbiddenException(
        'Faculty can only change questions they created',
      );
    }
    return question;
  }

  private async resolveCourseSubject(dto: CreateQuestionDto): Promise<bigint> {
    if (dto.courseSubjectId !== undefined) {
      const cs = await this.prisma.course_subjects.findUnique({
        where: { id: BigInt(dto.courseSubjectId) },
        select: { id: true },
      });
      if (!cs)
        throw new BadRequestException(
          'courseSubjectId does not match any course subject',
        );
      return cs.id;
    }
    if (dto.courseId === undefined || dto.subjectId === undefined) {
      throw new BadRequestException(
        'Provide courseSubjectId, or both courseId and subjectId',
      );
    }
    const cs = await this.prisma.course_subjects.findUnique({
      where: {
        course_id_subject_id: {
          course_id: BigInt(dto.courseId),
          subject_id: BigInt(dto.subjectId),
        },
      },
      select: { id: true },
    });
    if (!cs)
      throw new BadRequestException('This subject is not part of the course');
    return cs.id;
  }

  private async resolveChapter(
    courseSubjectId: bigint,
    chapterId?: number | null,
  ): Promise<bigint | null | undefined> {
    if (chapterId === undefined || chapterId === null) return chapterId;
    const chapter = await this.prisma.chapters.findUnique({
      where: { id: BigInt(chapterId) },
      select: { course_subject_id: true },
    });
    if (!chapter || chapter.course_subject_id !== courseSubjectId) {
      throw new BadRequestException(
        'chapterId must be a chapter of the same course subject',
      );
    }
    return BigInt(chapterId);
  }
}
