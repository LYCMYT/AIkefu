// Integration tests exercise the real application and, when enabled, its real
// PostgreSQL/Redis/MinIO boundaries. Hosted model credentials are a separate
// explicit gate and must never leak in from a developer's local .env file.
for (const key of [
  'AI_PROVIDER',
  'AI_API_STYLE',
  'AI_BASE_URL',
  'AI_API_KEY',
  'AI_API_KEY_FILE',
  'AI_FAST_MODEL',
  'AI_QUALITY_MODEL',
  'AI_MULTIMODAL_MODEL',
  'AI_JUDGE_MODEL',
  'AI_MODEL_GATEWAY_URL',
  'AI_MODEL_GATEWAY_SECRET',
  'AI_MODEL_NAME',
]) {
  delete process.env[key];
}
process.env.AI_OFFLINE_MODE = '1';
