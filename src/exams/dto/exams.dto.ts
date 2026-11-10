import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  exam_attempts_status,
  exams_kind,
  exams_ranking_attempt_policy,
  exams_status,
  questions_difficulty,
} from '../../generated/prisma/enums.js';
import { PaginationQueryDto, toBoolean } from '../../common/pagination.js';
import { trim } from '../../common/validation.js';

const MARKS = { maxDecimalPlaces: 2 } as const;

// ---------------------------------------------------------------------------
// Question bank
// ---------------------------------------------------------------------------

export class QuestionOptionDto {
  /** Short label shown to students. @example "A" */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z0-9]{1,8}$/, {
    message: 'optionLabel must be 1-8 letters or digits, e.g. A',
  })
  optionLabel: string;

  @IsString()
  @Length(1, 10000)
  optionText: string;

  @IsBoolean()
  isCorrect: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class CreateQuestionDto {
  /** Identify the course subject either by courseSubjectId, or by courseId + subjectId. */
  @IsOptional()
  @IsInt()
  @Min(1)
  courseSubjectId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  courseId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  subjectId?: number;

  /** Must belong to the same course subject. */
  @IsOptional()
  @IsInt()
  @Min(1)
  chapterId?: number | null;

  @IsString()
  @Length(1, 20000)
  questionText: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  explanation?: string | null;

  @IsOptional()
  @IsIn(Object.values(questions_difficulty))
  difficulty?: questions_difficulty;

  /** Default marks when the question is added to an exam (2 decimals). */
  @IsOptional()
  @IsNumber(MARKS)
  @Min(0)
  @Max(9999)
  marksDefault?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** SINGLE_CHOICE: 2-8 options with unique labels and exactly one correct. */
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => QuestionOptionDto)
  options: QuestionOptionDto[];
}

export class UpdateQuestionDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  chapterId?: number | null;

  @IsOptional()
  @IsString()
  @Length(1, 20000)
  questionText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  explanation?: string | null;

  @IsOptional()
  @IsIn(Object.values(questions_difficulty))
  difficulty?: questions_difficulty;

  @IsOptional()
  @IsNumber(MARKS)
  @Min(0)
  @Max(9999)
  marksDefault?: number;

  /** Set false to retire a question that has been used in attempts. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Replaces all options. Refused (409) once the question has appeared in an attempt. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => QuestionOptionDto)
  options?: QuestionOptionDto[];
}

export class ListQuestionsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  courseId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  subjectId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  courseSubjectId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  chapterId?: number;

  @IsOptional()
  @IsIn(Object.values(questions_difficulty))
  difficulty?: questions_difficulty;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isActive?: boolean;

  /** Matches the question text. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  search?: string;
}

// ---------------------------------------------------------------------------
// Exams
// ---------------------------------------------------------------------------

export class CreateExamDto {
  @IsInt()
  @Min(1)
  courseId: number;

  /** Optional: a single-subject test. Must be one of the course's subjects. */
  @IsOptional()
  @IsInt()
  @Min(1)
  subjectId?: number | null;

  /** @example "Physics Chapter Test: Laws of Motion" */
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  title: string;

  @IsIn(Object.values(exams_kind))
  kind: exams_kind;

  /** @example 60 */
  @IsInt()
  @Min(1)
  @Max(1440)
  durationMinutes: number;

  /** Default penalty for a wrong answer, copied to each question added afterwards. */
  @IsOptional()
  @IsNumber(MARKS)
  @Min(0)
  @Max(9999)
  negativeMarksPerWrong?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxAttempts?: number;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  opensAt?: Date | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  closesAt?: Date | null;

  /** When students may see scores (if showResultImmediately is false). */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  resultsReleaseAt?: Date | null;

  /** When students may see correct answers and explanations. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  answerReviewReleaseAt?: Date | null;

  /** Which attempt counts on the leaderboard when several are allowed. */
  @IsOptional()
  @IsIn(Object.values(exams_ranking_attempt_policy))
  rankingAttemptPolicy?: exams_ranking_attempt_policy;

  @IsOptional()
  @IsBoolean()
  showResultImmediately?: boolean;
}

export class UpdateExamDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  subjectId?: number | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  title?: string;

  @IsOptional()
  @IsIn(Object.values(exams_kind))
  kind?: exams_kind;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  durationMinutes?: number;

  @IsOptional()
  @IsNumber(MARKS)
  @Min(0)
  @Max(9999)
  negativeMarksPerWrong?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxAttempts?: number;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  opensAt?: Date | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  closesAt?: Date | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  resultsReleaseAt?: Date | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  answerReviewReleaseAt?: Date | null;

  @IsOptional()
  @IsIn(Object.values(exams_ranking_attempt_policy))
  rankingAttemptPolicy?: exams_ranking_attempt_policy;

  @IsOptional()
  @IsBoolean()
  showResultImmediately?: boolean;

  /** PUBLISHED requires at least one question and one batch. Back to DRAFT only while there are no attempts. */
  @IsOptional()
  @IsIn(Object.values(exams_status))
  status?: exams_status;
}

export class ListExamsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  courseId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  batchId?: number;

  @IsOptional()
  @IsIn(Object.values(exams_status))
  status?: exams_status;
}

export class AddExamQuestionDto {
  @IsInt()
  @Min(1)
  questionId: number;

  /** Defaults to the question's marks_default. */
  @IsOptional()
  @IsNumber(MARKS)
  @Min(0)
  @Max(9999)
  marks?: number;

  /** Defaults to the exam's negative_marks_per_wrong. */
  @IsOptional()
  @IsNumber(MARKS)
  @Min(0)
  @Max(9999)
  negativeMarks?: number;
}

export class UpdateExamQuestionDto {
  @IsOptional()
  @IsNumber(MARKS)
  @Min(0)
  @Max(9999)
  marks?: number;

  @IsOptional()
  @IsNumber(MARKS)
  @Min(0)
  @Max(9999)
  negativeMarks?: number;
}

export class ReorderExamQuestionsDto {
  /** Every question id of the exam, in the new order. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsInt({ each: true })
  questionIds: number[];
}

// ---------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------

export class StartAttemptDto {
  /** Only needed if you are enrolled in more than one of the exam's batches. */
  @IsOptional()
  @IsInt()
  @Min(1)
  batchId?: number;
}

export class SaveAnswerDto {
  /** The chosen option, or null to clear the answer. */
  @IsOptional()
  @IsInt()
  @Min(1)
  selectedOptionId?: number | null;

  @IsOptional()
  @IsBoolean()
  isMarkedForReview?: boolean;
}

export class ListAttemptsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  batchId?: number;

  @IsOptional()
  @IsIn(Object.values(exam_attempts_status))
  status?: exam_attempts_status;
}

export class MyAttemptsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  examId?: number;
}

export class LeaderboardQueryDto {
  /** Limit the ranking to one batch. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  batchId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}
