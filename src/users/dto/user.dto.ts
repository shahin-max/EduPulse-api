import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDate,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { users_status } from '../../generated/prisma/enums.js';
import { ALL_ROLES, RoleCode } from '../../common/auth.js';
import { PaginationQueryDto, toBoolean } from '../../common/pagination.js';
import { StudentSelfProfileDto } from '../../auth/dto/auth.dto.js';
import {
  EmailUnlessMobile,
  lowerTrim,
  MOBILE_MESSAGE,
  MOBILE_REGEX,
  PASSWORD_MESSAGE,
  PASSWORD_REGEX,
  toMobile,
  trim,
} from '../../common/validation.js';

export class CreateUserDto {
  @Transform(trim)
  @IsString()
  @Length(2, 160)
  fullName: string;

  @EmailUnlessMobile()
  @Transform(lowerTrim)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @Transform(toMobile)
  @Matches(MOBILE_REGEX, { message: MOBILE_MESSAGE })
  mobile?: string;

  /**
   * Optional. With a password the account is ACTIVE straight away. Without one it is
   * PENDING and the response contains a `setupToken` for the user to set their own password.
   */
  @IsOptional()
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  password?: string;

  /** One or more of ADMIN, FACULTY, STUDENT. @example ["FACULTY"] */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(ALL_ROLES, { each: true })
  roles: RoleCode[];
}

export class UpdateUserDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 160)
  fullName?: string;

  /** Changing the email clears its verification. */
  @IsOptional()
  @Transform(lowerTrim)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  /** Changing the mobile clears its verification. */
  @IsOptional()
  @Transform(toMobile)
  @Matches(MOBILE_REGEX, { message: MOBILE_MESSAGE })
  mobile?: string;

  /** SUSPENDED or DISABLED signs the user out everywhere and blocks login. */
  @IsOptional()
  @IsIn(Object.values(users_status))
  status?: users_status;
}

export class SetRolesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(ALL_ROLES, { each: true })
  roles: RoleCode[];
}

export class ListUsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(ALL_ROLES)
  role?: RoleCode;

  @IsOptional()
  @IsIn(Object.values(users_status))
  status?: users_status;

  /** Matches name, email or mobile. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  /** Include soft-deleted users. */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeDeleted?: boolean;
}

/** Everything on a student profile; admins can also set admission number and joining date. */
export class AdminStudentProfileDto extends StudentSelfProfileDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  admissionNumber?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  joinedOn?: Date;
}

export class FacultySelfProfileDto {
  /** @example "M.Sc. Physics, B.Ed." */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  qualification?: string;

  /** @example "Mechanics and Electrodynamics for JEE" */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  specialization?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  biography?: string;
}

export class AdminFacultyProfileDto extends FacultySelfProfileDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  employeeCode?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  joinedOn?: Date;
}
