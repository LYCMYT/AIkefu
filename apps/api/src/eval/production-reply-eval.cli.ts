import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { PrismaService } from '../database/prisma.service';
import { MESSAGE_APPLICATION, type MessageApplication } from '../messages/message.application';
import { WorkspaceService } from '../workspaces/workspace.service';
import { AttachmentService } from '../attachments/attachments.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ContextInvalidationService } from '../replies/context-invalidation.service';
import { ConversationReplyControlService } from '../replies/conversation-reply-control.service';
import { ReplyDraftService } from '../replies/reply-draft.service';
import { AiEvalFaultRegistry } from './ai-eval-fault-registry';
import { WorkflowProposalService } from '../workflow/workflow-proposal.service';
import { ReplyRecoveryService } from '../replies/reply-recovery.service';
import { SendOutboxService } from '../replies/send-outbox.service';
import {
  PrismaProductionReplyEvalPort,
  ProductionReplyEvalExecutor,
} from './production-reply-eval-executor';
import { ReplyEvalRunner, type ReplyEvalCase } from './reply-eval-runner';

type EvalFile = { version: string; cases: ReplyEvalCase[] };

const AI_ENVIRONMENT_KEYS = [
  'AI_PROVIDER', 'AI_API_STYLE', 'AI_BASE_URL', 'AI_API_KEY', 'AI_API_KEY_FILE',
  'AI_FAST_MODEL', 'AI_QUALITY_MODEL', 'AI_MULTIMODAL_MODEL', 'AI_JUDGE_MODEL',
  'AI_MODEL_GATEWAY_URL', 'AI_MODEL_GATEWAY_SECRET', 'AI_MODEL_NAME',
] as const;

async function main(): Promise<void> {
  const realProvider = process.argv.includes('--real-provider');
  const offline = process.argv.includes('--offline-fixture');
  if (realProvider === offline) throw new Error('Choose exactly one of --real-provider or --offline-fixture');
  if (!process.env.DATABASE_URL?.trim()) throw new Error('DATABASE_URL is required for production reply evaluation');
  if (realProvider && !process.env.AI_PROVIDER?.trim()) throw new Error('AI_PROVIDER is required for --real-provider');
  if (await portListening(Number(process.env.PORT ?? 3000))) {
    throw new Error('PRODUCTION_EVAL_REQUIRES_API_STOPPED: stop the API so one runtime exclusively owns durable work');
  }
  if (offline) {
    for (const key of AI_ENVIRONMENT_KEYS) delete process.env[key];
    process.env.AI_OFFLINE_MODE = '1';
  }

  const autoSuite = process.argv.includes('--auto-suite');
  const source = loadCases(autoSuite);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const port = new PrismaProductionReplyEvalPort(
      app.get(WorkspaceService),
      app.get<MessageApplication>(MESSAGE_APPLICATION),
      app.get(PrismaService),
      {
        timeoutMs: positiveInteger(process.env.AI_EVAL_CASE_TIMEOUT_MS, realProvider ? 90_000 : 45_000),
        pollMs: 100,
      },
      app.get(AttachmentService),
      app.get(KnowledgeService),
      app.get(ContextInvalidationService),
      app.get(ConversationReplyControlService),
      app.get(ReplyDraftService),
      app.get(AiEvalFaultRegistry),
      app.get(WorkflowProposalService),
      app.get(ReplyRecoveryService),
      app.get(SendOutboxService),
    );
    const executor = new ProductionReplyEvalExecutor(port);
    const runner = new ReplyEvalRunner();
    const mode = realProvider ? 'PRODUCTION_REAL_PROVIDER' as const : 'PRODUCTION_OFFLINE' as const;
    const report = await runner.run({
      mode,
      provider: realProvider ? process.env.AI_PROVIDER : 'offline-structured-demo',
      model: realProvider ? configuredModel() : 'offline-structured-v1',
      cases: source.cases,
      execute: (testCase) => executor.execute(testCase),
    });
    writeReports(source.version, runner, report, autoSuite ? 'reply-auto-eval' : 'reply-eval');
    process.stdout.write(`${mode}: ${report.summary.passed}/${report.summary.total} passed; ${report.summary.failed} failed\n`);
    process.stdout.write(`Reports: artifacts/eval/${autoSuite ? 'reply-auto-eval' : 'reply-eval'}-${mode.toLowerCase()}-latest.{json,md}\n`);
    if (process.argv.includes('--fail-on-regression') && report.summary.failed > 0) process.exitCode = 2;
  } finally {
    await app.close();
  }
}

function loadCases(autoSuite: boolean): EvalFile {
  const expectedCount = autoSuite ? 10 : 36;
  const filename = autoSuite ? 'auto-eval-cases.json' : 'eval-cases.json';
  const source = JSON.parse(readFileSync(resolve(process.cwd(), 'seed', filename), 'utf8')) as EvalFile;
  if (!Array.isArray(source.cases) || source.cases.length !== expectedCount) {
    throw new Error(`Expected exactly ${expectedCount} ${autoSuite ? 'AUTO' : 'fixed'} eval cases, received ${source.cases?.length ?? 0}`);
  }
  return source;
}

function writeReports(
  sourceVersion: string,
  runner: ReplyEvalRunner,
  report: Awaited<ReturnType<ReplyEvalRunner['run']>>,
  reportFamily: 'reply-eval' | 'reply-auto-eval',
): void {
  const outputDirectory = resolve(process.cwd(), 'artifacts/eval');
  mkdirSync(outputDirectory, { recursive: true });
  const timestamp = report.generatedAt.replaceAll(':', '-').replaceAll('.', '-');
  const prefix = `${reportFamily}-${report.mode.toLowerCase()}`;
  const json = `${JSON.stringify({ sourceVersion, executionBoundary: 'APP_MODULE_PRISMA_REPLY_RUNTIME', ...report }, null, 2)}\n`;
  const markdown = `${runner.toMarkdown(report)}\n`;
  for (const [name, content] of [
    [`${prefix}-${timestamp}.json`, json], [`${prefix}-${timestamp}.md`, markdown],
    [`${prefix}-latest.json`, json], [`${prefix}-latest.md`, markdown],
  ] as const) writeFileSync(resolve(outputDirectory, name), content, 'utf8');
}

function configuredModel(): string {
  return process.env.AI_MODEL_NAME?.trim()
    || process.env.AI_QUALITY_MODEL?.trim()
    || process.env.AI_FAST_MODEL?.trim()
    || 'configured-model';
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

async function portListening(port: number): Promise<boolean> {
  return new Promise((resolveListening) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (listening: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveListening(listening);
    };
    socket.setTimeout(300);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
