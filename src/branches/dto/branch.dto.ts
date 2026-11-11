import { PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  lowerTrim,
  MOBILE_MESSAGE,
  MOBILE_REGEX,
  toMobile,
  trim,
  upperTrim,
} from '../../common/validation.js';

/** Same rule as chk_branches_code in the database. */
const BRANCH_CODE_REGEX = /^[A-Z0-9]{2,20}$/;
const PREFIX_REGEX = /^[A-Z0-9]{1,10}$/;

export class CreateBranchDto {
  /** Short unique code, 2-20 letters or digits. @example "ALG" */
  @Transform(upperTrim)
  @Matches(BRANCH_CODE_REGEX, {
    message: 'code must be 2-20 letters or digits',
  })
  code: string;

  /** @example "Aligarh - Civil Lines" */
  @Transform(trim)
  @IsString()
  @Length(2, 160)
  name: string;

  /** Prefix for this branch's invoice numbers. @example "ALG" */
  @Transform(upperTrim)
  @Matches(PREFIX_REGEX, {
    message: 'invoicePrefix must be 1-10 letters or digits',
  })
  invoicePrefix: string;

  /** Prefix for this branch's receipt numbers. @example "ALGR" */
  @Transform(upperTrim)
  @Matches(PREFIX_REGEX, {
    message: 'receiptPrefix must be 1-10 letters or digits',
  })
  receiptPrefix: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  address?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  city?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  state?: string;

  /** Indian PIN code. @example "202001" */
  @IsOptional()
  @Transform(trim)
  @Matches(/^[0-9]{6}$/, { message: 'pincode must be 6 digits' })
  pincode?: string;

  @IsOptional()
  @Transform(toMobile)
  @Matches(MOBILE_REGEX, { message: MOBILE_MESSAGE })
  phone?: string;

  @IsOptional()
  @Transform(lowerTrim)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  /** 15-character GST identification number. */
  @IsOptional()
  @Transform(upperTrim)
  @Matches(/^[0-9]{2}[A-Z0-9]{13}$/, {
    message: 'gstin must be a 15-character GSTIN',
  })
  gstin?: string;

  /** Inactive branches cannot get new batches. Defaults to true. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateBranchDto extends PartialType(CreateBranchDto) {}
