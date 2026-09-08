import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { validateEnvironment } from './common/environment';
import { configureHttpApplication } from './common/http-bootstrap';
import { PrismaService } from './database/prisma.service';
import { acquireDatabaseLease } from './eval-v2/database-lease';

async function bootstrap(): Promise<void> {
  const environment = validateEnvironment(process.env);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const lease = databaseUrl ? acquireDatabaseLease(databaseUrl) : undefined;
  let app: NestExpressApplication | undefined;
  try {
    app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
    configureHttpApplication(app, environment);
    app.enableShutdownHooks();
    await app.get(PrismaService).$connect();
    const server = await app.listen(environment.apiPort);
    server.once('close', () => lease?.release());
  } catch (error) {
    await app?.close();
    lease?.release();
    throw error;
  }
}

void bootstrap();
