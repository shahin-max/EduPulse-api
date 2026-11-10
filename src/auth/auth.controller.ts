import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AuthUser } from '../common/auth.js';
import { CurrentUser, Public } from '../common/auth.js';
import { AuthService } from './auth.service.js';
import {
  ChangePasswordDto,
  ConfirmVerificationDto,
  ForgotPasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  RequestVerificationDto,
  ResetPasswordDto,
} from './dto/auth.dto.js';

const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Student sign-up with email and/or mobile. Returns tokens so the student is logged in immediately. */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  /** Log in with email or mobile and password (all roles). Each login is a separate session. */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  /** Exchange a refresh token for a new pair. The presented refresh token stops working. */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  /** End the current session. */
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  logout(@CurrentUser() user: AuthUser) {
    return this.auth.logout(user.id, user.sessionId);
  }

  /** End every session on every device. */
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout-all')
  logoutAll(@CurrentUser() user: AuthUser) {
    return this.auth.logoutAll(user.id);
  }

  /** The logged-in user with roles and student/faculty profile. */
  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  /** Change your password. Signs out your other devices. */
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Patch('password')
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.auth.changePassword(user.id, user.sessionId, dto);
  }

  /** Request a password reset token (valid 1 hour). The response is the same whether or not the account exists. */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('password/forgot')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.login);
  }

  /** Set a new password with a reset or invitation token. Activates invited accounts. */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('password/reset')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.newPassword);
  }

  /** Send a verification token to your email or mobile (valid 24 hours). */
  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('verify/request')
  requestVerification(
    @CurrentUser() user: AuthUser,
    @Body() dto: RequestVerificationDto,
  ) {
    return this.auth.requestVerification(user.id, dto.channel);
  }

  /** Confirm an email or mobile verification token. */
  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(HttpStatus.OK)
  @Post('verify/confirm')
  confirmVerification(@Body() dto: ConfirmVerificationDto) {
    return this.auth.confirmVerification(dto.token);
  }
}
