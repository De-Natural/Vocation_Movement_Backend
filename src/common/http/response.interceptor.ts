import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SuccessResponse } from './response';

/**
 * Wraps controller return values in the standard success envelope
 * (PRD §10.1). If a controller already returns an object with a
 * `success` boolean, it is passed through untouched (so services that
 * build their own envelope, e.g. paginated responses via `ok()`, work).
 */
@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, SuccessResponse<T> | T>
{
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<SuccessResponse<T> | T> {
    return next.handle().pipe(
      map((data) => {
        if (
          data &&
          typeof data === 'object' &&
          'success' in (data as Record<string, unknown>)
        ) {
          return data;
        }
        return { success: true, data } as SuccessResponse<T>;
      }),
    );
  }
}
