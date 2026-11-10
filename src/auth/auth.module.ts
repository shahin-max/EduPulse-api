import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { OneTimeTokenService } from './one-time-token.service.js';
import { PasswordService } from './password.service.js';

@Global()
@Module({
  // Secrets and TTLs are passed per call, so access and refresh tokens use different keys.
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, OneTimeTokenService],
  exports: [JwtModule, PasswordService, OneTimeTokenService],
})
export class AuthModule {}
