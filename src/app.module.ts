import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './config/env.validation.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AppMailModule } from './mail/mail.module.js';
import { AccessModule } from './common/access.service.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { RolesGuard } from './common/guards/roles.guard.js';
import { AuditInterceptor } from './audit/audit.interceptor.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { BatchesModule } from './batches/batches.module.js';
import { BranchesModule } from './branches/branches.module.js';
import { WebsiteModule } from './website/website.module.js';
import { LearningModule } from './learning/learning.module.js';
import { ExamsModule } from './exams/exams.module.js';
import { ClassesModule } from './classes/classes.module.js';
import { FeesModule } from './fees/fees.module.js';
import { CommunicationsModule } from './communications/communications.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
      // Tests hammer login and public forms; rate limits would make them flaky.
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    PrismaModule,
    AppMailModule,
    AccessModule,
    AuthModule,
    UsersModule,
    CatalogModule,
    BranchesModule,
    BatchesModule,
    WebsiteModule,
    LearningModule,
    ExamsModule,
    ClassesModule,
    FeesModule,
    CommunicationsModule,
    AuditModule,
  ],
  controllers: [HealthController],
  providers: [
    // Order matters: rate limit, then authenticate, then check roles.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
