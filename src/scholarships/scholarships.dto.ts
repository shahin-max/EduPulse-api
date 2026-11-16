import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { trim } from '../common/validation.js';

/** A score band: students at or above `minPercentage` win `discountPercent` off their course fees. */
export class ScholarshipSlabDto {
  /** @example 90 */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  minPercentage: number;

  /** @example 50 */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  discountPercent: number;
}

class ScholarshipFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string | null;

  /** Classes that may register, e.g. ["Class 5", "Class 6"]; empty = any class. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @Length(1, 20, { each: true })
  eligibleGrades?: string[];

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  registrationClosesAt?: Date | null;

  /** Last day a won scholarship can be applied to a fee invoice. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  validUntil?: Date | null;
}

export class CreateScholarshipTestDto extends ScholarshipFieldsDto {
  /** @example "EduPulse Scholarship Test 2027" */
  @Transform(trim)
  @IsString()
  @Length(3, 200)
  title: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ScholarshipSlabDto)
  slabs: ScholarshipSlabDto[];

  /** The window in which candidates can take the test online. */
  @Type(() => Date)
  @IsDate()
  opensAt: Date;

  @Type(() => Date)
  @IsDate()
  closesAt: Date;

  @IsInt()
  @Min(5)
  @Max(600)
  durationMinutes: number;

  /** OMR answer-sheet layout instead of one question at a time. */
  @IsOptional()
  @IsBoolean()
  omr?: boolean;
}

export class UpdateScholarshipTestDto extends ScholarshipFieldsDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(3, 200)
  title?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ScholarshipSlabDto)
  slabs?: ScholarshipSlabDto[];
}

export class JoinScholarshipTestDto {
  /** The student's current class, e.g. "Class 5". */
  @Transform(trim)
  @IsString()
  @Length(1, 20)
  grade: string;
}

export class OverrideAwardDto {
  /** % off course fees; null clears the override and goes back to the slab. */
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  discountPercent: number | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}
