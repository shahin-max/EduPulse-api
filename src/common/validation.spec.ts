import { plainToInstance } from 'class-transformer';
import { IsOptional, IsString, validate } from 'class-validator';
import { RegisterDto } from '../auth/dto/auth.dto.js';
import { AtLeastOneOf, normalizeMobile } from './validation.js';

class Material {
  @AtLeastOneOf(['assetId', 'externalUrl'])
  @IsOptional()
  @IsString()
  assetId?: string;

  @IsOptional()
  @IsString()
  externalUrl?: string;
}

async function messages<T extends object>(
  cls: new () => T,
  plain: object,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('AtLeastOneOf', () => {
  it('still runs when the decorated property is @IsOptional and absent', async () => {
    expect(await messages(Material, {})).toEqual([
      'at least one of assetId, externalUrl is required',
    ]);
  });

  it('passes when either property is present', async () => {
    expect(await messages(Material, { externalUrl: 'https://x.test' })).toEqual(
      [],
    );
    expect(await messages(Material, { assetId: 'a' })).toEqual([]);
  });
});

describe('RegisterDto contact rule (chk_users_contact)', () => {
  const base = { fullName: 'Aman Khan', password: 'Secret123' };

  it('requires an email or a mobile', async () => {
    expect(await messages(RegisterDto, base)).toContain(
      'email or mobile is required',
    );
  });

  it('accepts mobile only, normalising spaces', async () => {
    const dto = plainToInstance(RegisterDto, {
      ...base,
      mobile: '+91 98765 43210',
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto.mobile).toBe('+919876543210');
  });

  it('validates the email format when an email is given', async () => {
    expect(
      (
        await messages(RegisterDto, {
          ...base,
          mobile: '9876543210',
          email: 'nope',
        })
      ).join(),
    ).toMatch(/email/);
  });

  it('rejects unknown fields such as roles', async () => {
    expect(
      (
        await messages(RegisterDto, {
          ...base,
          mobile: '9876543210',
          roles: ['ADMIN'],
        })
      ).join(),
    ).toMatch(/roles/);
  });
});

describe('normalizeMobile', () => {
  it.each([
    ['98765 43210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['+91 98765-43210', '+919876543210'],
    ['(+91) 98765 43210', '+919876543210'],
    ['+44 7700 900123', '+447700900123'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeMobile(input)).toBe(expected);
  });

  it('leaves numbers that are not Indian mobiles alone apart from spacing', () => {
    expect(normalizeMobile('12345 67890')).toBe('1234567890');
  });
});
