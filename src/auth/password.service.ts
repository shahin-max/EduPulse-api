import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';

@Injectable()
export class PasswordService {
  private readonly rounds: number;

  constructor(config: ConfigService) {
    this.rounds = Number(config.get('BCRYPT_ROUNDS') ?? 10);
  }

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.rounds);
  }

  verify(plain: string, hash: string | null): Promise<boolean> {
    return hash ? bcrypt.compare(plain, hash) : Promise.resolve(false);
  }
}
