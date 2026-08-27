import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { navigationItems } from './App';

const repositoryRoot = resolve(__dirname, '../../..');
const readRepositoryFile = (relativePath: string) => readFileSync(resolve(repositoryRoot, relativePath), 'utf8');

describe('Phase 05 release handoff documentation', () => {
  it('documents the reproducible local path, four entries, and infrastructure opt-in', () => {
    const readme = readRepositoryFile('README.md');

    expect(readme).toContain('Phase 05');
    expect(readme).toContain('Mock-only');
    expect(readme).toContain('/workbench');
    expect(readme).toContain('/admin');
    expect(readme).toContain('/buyer-simulator');
    expect(readme).toContain('/scenario-lab');
    expect(readme).toContain('RUN_REAL_INFRA_INTEGRATION=1');
    expect(readme).toContain('RUN_REAL_INFRA_INTEGRATION=1 pnpm exec dotenv');
    expect(readme).toContain('pnpm exec dotenv -e .env -- pnpm --filter @ai-customer-service/api test:integration');
    expect(readme).toContain('pnpm test:unit');
    expect(readme).toContain('pnpm test:integration');
    expect(readme).toContain('docs/18_DEMO_SCRIPT.md');
    expect(readme).toContain('docs/19_KNOWN_LIMITATIONS.md');
    expect(readme).toContain('无真实');
  });

  it('keeps the release script and known limitations explicit about verification boundaries', () => {
    const demoScript = readRepositoryFile('docs/18_DEMO_SCRIPT.md');
    const limitations = readRepositoryFile('docs/19_KNOWN_LIMITATIONS.md');
    const environment = readRepositoryFile('.env.example');
    const compose = readRepositoryFile('docker-compose.yml');

    expect(demoScript).toContain('验证说明');
    expect(demoScript).toContain('trace=1');
    expect(demoScript).toContain('Mock');
    expect(demoScript).toContain('真实外部平台发送不在 V1 范围');
    expect(limitations).toContain('不声称在线部署');
    expect(limitations).toContain('不虚构商业 KPI');
    expect(environment).toContain('RUN_REAL_INFRA_INTEGRATION=0');
    expect(environment).toContain('AI_API_KEY');
    expect(environment).toContain('VITE_WS_BASE_URL=');
    expect(compose).toContain('pgvector/pgvector:pg16');
    expect(compose).toContain('redis:7-alpine');
    expect(compose).toContain('minio/minio');
  });

  it('keeps exactly four top-level product entries while nesting admin tools', () => {
    expect(navigationItems.map((item) => item.path)).toEqual([
      '/workbench',
      '/buyer-simulator',
      '/admin',
      '/scenario-lab',
    ]);
  });

  it('keeps Phase 05 resource pages on real loading/error/empty branches and narrow layouts', () => {
    const app = readRepositoryFile('apps/web/src/App.tsx');
    const styles = readRepositoryFile('apps/web/src/styles.css');

    for (const page of ['WorkflowAdminPage', 'QualityAdminPage', 'IncidentAdminPage', 'UsageAdminPage', 'ScenarioLabPage']) {
      expect(app).toContain(`function ${page}`);
    }
    expect(app.match(/Phase05LoadingState/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(app.match(/Phase05ErrorState message=\{resourceError\}/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(app).toContain('暂无用量快照');
    expect(app).toContain('暂无场景快照');
    expect(styles).toContain('@media (max-width: 700px)');
    expect(styles).toContain('.phase05-resource-grid');
    expect(styles).toContain('.workflow-canvas-wrap');
    expect(styles).toContain('overflow-x: auto');
    expect(styles).toContain('grid-template-columns: repeat(3, minmax(0, 1fr));');
  });
});
