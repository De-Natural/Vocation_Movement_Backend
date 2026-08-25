import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { Prisma } from '@prisma/client';
import { AppException } from './app-exception';
import { ErrorResponse } from './response';

/**
 * Global exception filter — renders every thrown error into the standard
 * error envelope (PRD §10.1). Maps Prisma errors to sensible codes and
 * ensures 500s never leak internals (PRD §10.2 note).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred.';
    let details: unknown;

    if (exception instanceof AppException) {
      statusCode = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      // Nest built-in exceptions (e.g. from guards)
      statusCode = exception.getStatus();
      const resp = exception.getResponse();
      message =
        typeof resp === 'string'
          ? resp
          : ((resp as { message?: string | string[] }).message as string) ??
            exception.message;
      if (Array.isArray(message)) {
        details = message;
        message = 'Validation failed';
        code = 'VALIDATION_ERROR';
      } else {
        code = httpStatusToCode(statusCode);
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      ({ statusCode, code, message } = mapPrismaError(exception));
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    // Log server errors with full detail; never expose them to the client.
    if (statusCode >= 500) {
      this.logger.error(
        `${code}: ${(exception as Error)?.message ?? 'unknown'}`,
        (exception as Error)?.stack,
      );
      message = 'An unexpected error occurred.';
      details = undefined;
    }

    const body: ErrorResponse = {
      success: false,
      error: {
        code,
        message,
        statusCode,
        ...(details ? { details } : {}),
      },
    };

    res.status(statusCode).json(body);
  }
}

function httpStatusToCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'UNPROCESSABLE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'ERROR';
  }
}

function mapPrismaError(err: Prisma.PrismaClientKnownRequestError): {
  statusCode: number;
  code: string;
  message: string;
} {
  switch (err.code) {
    case 'P2002': // unique constraint
      return {
        statusCode: HttpStatus.CONFLICT,
        code: 'CONFLICT',
        message: 'A record with those details already exists.',
      };
    case 'P2025': // record not found
      return {
        statusCode: HttpStatus.NOT_FOUND,
        code: 'NOT_FOUND',
        message: 'The requested resource does not exist.',
      };
    case 'P2003': // FK constraint
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'BAD_REQUEST',
        message: 'A referenced resource does not exist.',
      };
    default:
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'DB_ERROR',
        message: 'A database error occurred.',
      };
  }
}
