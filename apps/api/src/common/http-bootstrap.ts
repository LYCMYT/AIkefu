import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { ValidatedEnvironment } from './environment';
import { createRequestValidationPipe } from './request-validation.pipe';

export function configureHttpApplication(app: NestExpressApplication, environment: ValidatedEnvironment): void {
  app.useBodyParser('json', { limit: environment.jsonBodyLimit });
  app.useBodyParser('urlencoded', { limit: environment.jsonBodyLimit, extended: false });
  app.use(helmet({
    hsts: environment.production ? undefined : false,
    referrerPolicy: { policy: 'no-referrer' },
  }));
  app.useGlobalPipes(createRequestValidationPipe());
  app.setGlobalPrefix('api');
  app.enableCors({ origin: environment.webOrigin, credentials: false });
}
