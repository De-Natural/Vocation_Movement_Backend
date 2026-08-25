import { PipeTransform, Injectable, ArgumentMetadata } from '@nestjs/common';
import { ZodSchema, ZodError } from 'zod';
import { AppException } from '../http/app-exception';

/**
 * Validates + parses a request payload against a Zod schema (PRD §5.2:
 * "All request bodies validated with Zod schemas before reaching the
 * controller"). Rejects with a 400 VALIDATION_ERROR carrying field details.
 *
 * Usage:  @Body(new ZodValidationPipe(loginSchema)) dto: LoginInput
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw AppException.badRequest(
        'Validation failed',
        'VALIDATION_ERROR',
        formatZodError(result.error),
      );
    }
    return result.data;
  }
}

function formatZodError(error: ZodError): Array<{ path: string; message: string }> {
  return error.errors.map((e) => ({
    path: e.path.join('.'),
    message: e.message,
  }));
}
