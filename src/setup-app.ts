import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import './common/bigint-json.js';
import { PrismaExceptionFilter } from './common/prisma-exception.filter.js';

export const API_PREFIX = 'api/v1';

const DESCRIPTION = [
  'Phase 1 backend for EduPulse Academy, Aligarh, on the `edupulse_lms` schema.',
  'Log in with `POST /api/v1/auth/login`, then click **Authorize** and paste the `accessToken`.',
  'Roles (a user can hold several): **ADMIN** manages everything; **FACULTY** teaches assigned batches ' +
    '(classes, attendance, materials, assignments, exams); **STUDENT** sees their own batches, content, results and fees.',
  'Ids are numbers, money and marks are decimal strings (e.g. `"1500.00"`), and field names in responses match the database (snake_case).',
].join('\n\n');

/** Shared by main.ts and the e2e tests so both run the exact same pipeline. */
export function setupApp(app: INestApplication): INestApplication {
  const config = app.get(ConfigService);

  // Behind Railway's (or any) reverse proxy every request comes from the proxy's address, so rate
  // limits would be shared by all visitors and audit logs would record the proxy. Trust exactly the
  // configured number of proxy hops (default 1 in production) so req.ip is the visitor's address;
  // a client cannot spoof it because only the hop the proxy itself appends is trusted.
  const hops = Number(
    config.get<string>('TRUST_PROXY') ??
      (config.get<string>('NODE_ENV') === 'production' ? '1' : '0'),
  );
  if (Number.isInteger(hops) && hops > 0)
    (app as NestExpressApplication).set('trust proxy', hops);

  app.setGlobalPrefix(API_PREFIX);
  app.use(helmet());
  const origins = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins.length ? origins : false });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new PrismaExceptionFilter());
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('EduPulse Academy API')
      .setDescription(DESCRIPTION)
      .setVersion('1.0.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: { persistAuthorization: true },
  });
  return app;
}
