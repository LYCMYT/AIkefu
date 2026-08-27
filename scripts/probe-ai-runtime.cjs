const { createServerAiRuntime } = require('../apps/api/dist/ai/ai-providers.js');
const { validateStructuredOutput } = require('../packages/core/dist/index.js');

async function main() {
  const runtime = createServerAiRuntime();
  const result = await runtime.runStructured({
    purpose: 'RISK_CLASSIFIER',
    input: { text: '用户询问普通商品材质，没有订单、支付或身份信息。' },
    validate: (value) => validateStructuredOutput('RiskResult', value),
    timeoutMs: 30_000,
  });
  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    provider: result.provider,
    model: result.model,
    fallbackUsed: result.fallbackUsed,
    usage: result.usage ?? null,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: 'FAIL',
    code: error?.code ?? 'UNKNOWN',
    message: error?.message ?? 'unknown',
  })}\n`);
  process.exitCode = 1;
});
