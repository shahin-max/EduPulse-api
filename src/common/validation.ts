import { applyDecorators } from '@nestjs/common';
import {
  IsDefined,
  registerDecorator,
  ValidateIf,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/** 10-15 digits with an optional leading +, after spaces are stripped. Same rule as the website form. */
export const MOBILE_REGEX = /^\+?[0-9]{10,15}$/;
export const MOBILE_MESSAGE =
  'mobile must be a valid phone number (10-15 digits, optional +)';

/** At least 8 chars with a letter and a digit. */
export const PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d).{8,72}$/;
export const PASSWORD_MESSAGE =
  'password must be 8-72 characters and contain a letter and a number';

/** Lowercase letters, digits and single hyphens, e.g. 'jee-main-2027'. */
export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Uppercase letters, digits, hyphen and underscore, e.g. 'NDA-CDS'. */
export const CODE_REGEX = /^[A-Z0-9][A-Z0-9_-]*$/;

export const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
export const lowerTrim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
export const upperTrim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;
/** '+91 98765 43210' -> '+919876543210', so the same number is always stored the same way. */
export const stripSpaces = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.replace(/\s+/g, '') : value;

/**
 * Canonical mobile form, so the same phone is stored and looked up one way. The academy is in
 * India, so bare 10-digit numbers (and 0- or 91-prefixed ones) get +91:
 * "98765 43210", "09876543210", "919876543210" and "+91 98765-43210" all become "+919876543210".
 * Other international numbers keep their own + prefix.
 */
export function normalizeMobile(value: string): string {
  const compact = value.replace(/[\s()-]+/g, '');
  if (/^[6-9]\d{9}$/.test(compact)) return `+91${compact}`;
  if (/^0[6-9]\d{9}$/.test(compact)) return `+91${compact.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(compact)) return `+${compact}`;
  return compact;
}

/** class-transformer hook for mobile fields; see normalizeMobile. */
export const toMobile = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? normalizeMobile(value) : value;

/** Converts a validated numeric id from a DTO into the bigint Prisma expects. */
export function toId(value: number): bigint;
export function toId(
  value: number | null | undefined,
): bigint | null | undefined;
export function toId(
  value: number | null | undefined,
): bigint | null | undefined {
  return value === null || value === undefined ? value : BigInt(value);
}

/**
 * Mirrors a CHECK constraint of the form "a IS NOT NULL OR b IS NOT NULL".
 *
 * It can sit on any property, even one marked @IsOptional(): the rule is registered on a
 * separate internal property name (not the decorated one), so IsOptional cannot skip it.
 */
export function AtLeastOneOf(
  properties: string[],
  options?: ValidationOptions,
) {
  return (object: object, _propertyName: string) =>
    registerDecorator({
      target: object.constructor,
      propertyName: `__atLeastOneOf(${properties.join('|')})`,
      options: {
        message: `at least one of ${properties.join(', ')} is required`,
        ...options,
      },
      constraints: properties,
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          const target = args.object as Record<string, unknown>;
          return (args.constraints as string[]).some(
            (key) =>
              target[key] !== undefined &&
              target[key] !== null &&
              target[key] !== '',
          );
        },
      },
    });
}

/**
 * Mirrors chk_users_contact: put on `email` (instead of @IsOptional) so that email is
 * validated when given, and required when `mobile` is missing.
 */
export function EmailUnlessMobile() {
  return applyDecorators(
    ValidateIf(
      (o: { email?: unknown; mobile?: unknown }) =>
        o.email !== undefined || !o.mobile,
    ),
    IsDefined({ message: 'email or mobile is required' }),
  );
}
