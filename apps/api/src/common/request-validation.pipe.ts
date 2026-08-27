import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

export function createRequestValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    stopAtFirstError: false,
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => new BadRequestException({
      code: 'REQUEST_VALIDATION_FAILED',
      message: validationMessages(errors).slice(0, 20),
    }),
  });
}

function validationMessages(errors: ValidationError[], prefix = ''): string[] {
  const messages: string[] = [];
  for (const error of errors) {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    if (error.constraints) {
      for (const key of Object.keys(error.constraints).sort()) messages.push(`${path}:${key}`);
    }
    if (error.children?.length) messages.push(...validationMessages(error.children, path));
  }
  return messages;
}
