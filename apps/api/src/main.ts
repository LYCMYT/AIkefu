import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { validateEnvironment } from './common/environment';
import { configureHttpApplication } from './common/http-bootstrap';
import { PrismaService } from './database/prisma.service';

async function bootstrap(): Promise<void> {
  const environment = validateEnvironment(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureHttpApplication(app, environment);
  app.enableShutdownHooks();
  await app.get(PrismaService).$connect();
  await app.listen(environment.apiPort);
}

void bootstrap();
