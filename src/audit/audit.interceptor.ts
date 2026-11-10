import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { AuthenticatedRequest, SKIP_AUDIT_KEY } from '../common/auth.js';
import { PrismaService } from '../prisma/prisma.service.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Writes an audit_logs row for every successful mutating request made by a logged-in
 * user. Request bodies are not stored (they may hold passwords); only which fields were sent.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!MUTATING.has(request.method) || skip) return next.handle();

    return next.handle().pipe(
      tap((result: unknown) => {
        // request.user is read after the handler so register/login (which create the user) are skipped.
        const user = request.user;
        if (!user) return;
        const controller = context.getClass().name.replace(/Controller$/, '');
        const params = request.params as Record<string, string>;
        const resultId =
          result && typeof result === 'object' && 'id' in result
            ? String((result as { id: unknown }).id)
            : undefined;
        const body =
          request.body && typeof request.body === 'object'
            ? Object.keys(request.body as object)
            : [];
        this.prisma.audit_logs
          .create({
            data: {
              actor_user_id: user.id,
              action: `${controller}.${context.getHandler().name}`.slice(
                0,
                100,
              ),
              entity_type: controller.slice(0, 80),
              entity_id: (params.id ?? resultId)?.slice(0, 80),
              metadata: {
                method: request.method,
                path: request.originalUrl.split('?')[0],
                params,
                fields: body,
              },
              ip_address: request.ip?.slice(0, 45),
            },
          })
          .catch((error: unknown) =>
            this.logger.error(`Failed to write audit log: ${String(error)}`),
          );
      }),
    );
  }
}
