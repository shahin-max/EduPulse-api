import { Transform, Type } from 'class-transformer';
import {
  IsDate,
  IsEmail,
  IsIn,
  IsJWT,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxDate,
  MaxLength,
} from 'class-validator';
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

/** Profile fields a student can fill in themselves (admission number and joining date are set by admins). */
export class StudentSelfProfileDto {
  /** ISO date, e.g. 2011-04-30 */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  @MaxDate(() => new Date(), { message: 'dateOfBirth must be in the past' })
  dateOfBirth?: Date;

  /** Class or grade, e.g. "9" or "12 (PCM)" */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 30)
  grade?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 160)
  schoolName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 160)
  guardianName?: string;

  @IsOptional()
  @Transform(toMobile)
  @Matches(MOBILE_REGEX, { message: MOBILE_MESSAGE })
  guardianMobile?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  address?: string;
}

/** Student self sign-up. Email or mobile (or both) is required. Faculty and admins are created by an admin. */
export class RegisterDto extends StudentSelfProfileDto {
  /** @example "Aman Khan" */
  @Transform(trim)
  @IsString()
  @Length(2, 160)
  fullName: string;

  /** @example "aman.khan@example.com" */
  @EmailUnlessMobile()
  @Transform(lowerTrim)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  /** @example "+91 98765 43210" */
  @IsOptional()
  @Transform(toMobile)
  @Matches(MOBILE_REGEX, { message: MOBILE_MESSAGE })
  mobile?: string;

  /** @example "Secret123" */
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  password: string;
}

export class LoginDto {
  /** Email address or mobile number. @example "admin@edupulse.local" */
  @Transform(trim)
  @IsString()
  @Length(3, 254)
  login: string;

  /** @example "ChangeMe@123" */
  @IsString()
  @MaxLength(72)
  password: string;
}

export class RefreshDto {
  @IsJWT()
  refreshToken: string;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(72)
  currentPassword: string;

  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  newPassword: string;
}

export class ForgotPasswordDto {
  /** Email address or mobile number of the account. */
  @Transform(trim)
  @IsString()
  @Length(3, 254)
  login: string;
}

export class ResetPasswordDto {
  /** The token delivered by "forgot password" or handed over by an admin. */
  @IsString()
  @Length(64, 64)
  token: string;

  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  newPassword: string;
}

export class RequestVerificationDto {
  @IsIn(['EMAIL', 'MOBILE'])
  channel: 'EMAIL' | 'MOBILE';
}

export class ConfirmVerificationDto {
  @IsString()
  @Length(64, 64)
  token: string;
}
