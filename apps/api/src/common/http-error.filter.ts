import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

type ErrorResponse = {
  code?: string;
  message?: string | string[];
  details?: unknown;
};

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse = exception instanceof HttpException ? exception.getResponse() : undefined;
    const normalized: ErrorResponse =
      typeof exceptionResponse === 'object' && exceptionResponse !== null
        ? (exceptionResponse as ErrorResponse)
        : { message: typeof exceptionResponse === 'string' ? exceptionResponse : undefined };
    const rawMessage = normalized.message;
    const message = Array.isArray(rawMessage)
      ? rawMessage.join('; ')
      : rawMessage ?? (status === 500 ? 'Internal server error' : 'Request failed');

    response.status(status).json({
      error: {
        code: normalized.code ?? `HTTP_${status}`,
        message,
        requestId: randomUUID(),
        details: normalized.details ?? {},
      },
    });
  }
}
