import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { Prisma } from '../generated/prisma/client.js';

const MAP: Record<string, { status: HttpStatus; message: string }> = {
  P2002: {
    status: HttpStatus.CONFLICT,
    message: 'A record with these details already exists',
  },
  P2003: {
    status: HttpStatus.CONFLICT,
    message:
      'This record is linked to other records and cannot be changed this way',
  },
  P2025: { status: HttpStatus.NOT_FOUND, message: 'Record not found' },
  // CHECK constraint violated; normally caught earlier by DTO/service validation.
  P2039: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The data breaks a database rule',
  },
};

/** Maps known Prisma errors to HTTP responses in Nest's standard error shape. */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(
    exception: Prisma.PrismaClientKnownRequestError,
    host: ArgumentsHost,
  ): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = MAP[exception.code];
    if (!mapped) {
      this.logger.error(
        `Unhandled Prisma error ${exception.code}: ${exception.message}`,
      );
    }
    const status = mapped?.status ?? HttpStatus.INTERNAL_SERVER_ERROR;
    response.status(status).json({
      statusCode: status,
      message:
        checkMessage(exception) ?? mapped?.message ?? 'Internal server error',
      error: HttpStatus[status],
    });
  }
}

/** "Check constraint chk_batch_dates is violated." -> names the rule without leaking anything else. */
function checkMessage(
  exception: Prisma.PrismaClientKnownRequestError,
): string | undefined {
  if (exception.code !== 'P2039') return undefined;
  // MySQL 3105: writing a GENERATED column such as fee_invoices.amount_due.
  const generated = /value specified for generated column '([a-z0-9_]+)'/i.exec(
    exception.message,
  )?.[1];
  if (generated)
    return `${generated} is calculated by the database and cannot be set`;
  const name = /Check constraint '([a-z0-9_]+)'/i.exec(exception.message)?.[1];
  return name ? `The data breaks the database rule ${name}` : undefined;
}
