import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Domain exception carrying a machine-readable error code (PRD §10.1).
 * Thrown by services; rendered by AllExceptionsFilter into the standard
 * error envelope.
 */
export class AppException extends HttpException {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    statusCode: HttpStatus,
    details?: unknown,
  ) {
    super(message, statusCode);
    this.code = code;
    this.details = details;
  }

  // ─── Convenience factories keyed to the PRD status-code table ───

  static badRequest(message: string, code = 'BAD_REQUEST', details?: unknown) {
    return new AppException(code, message, HttpStatus.BAD_REQUEST, details);
  }

  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new AppException(code, message, HttpStatus.UNAUTHORIZED);
  }

  static forbidden(message = 'You do not have permission to do that', code = 'FORBIDDEN') {
    return new AppException(code, message, HttpStatus.FORBIDDEN);
  }

  static notFound(message: string, code = 'NOT_FOUND') {
    return new AppException(code, message, HttpStatus.NOT_FOUND);
  }

  static conflict(message: string, code = 'CONFLICT') {
    return new AppException(code, message, HttpStatus.CONFLICT);
  }

  static unprocessable(message: string, code = 'UNPROCESSABLE') {
    return new AppException(code, message, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  static tooManyRequests(message = 'Too many requests', code = 'RATE_LIMITED') {
    return new AppException(code, message, HttpStatus.TOO_MANY_REQUESTS);
  }
}
