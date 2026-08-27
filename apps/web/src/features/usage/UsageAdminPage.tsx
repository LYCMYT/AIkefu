import { useQuery } from '@tanstack/react-query';
import { getUsageSummary } from '../../api';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/feedback';
import { AdminPageHeader, AdminTabs } from '../admin/AdminChrome';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

export function UsageAdminPage({ token, refreshKey }: { token: string; refreshKey: number }) {
  const usageQuery = useQuery({
    queryKey: ['usage', token, refreshKey],
    queryFn: () => getUsageSummary(token),
  });
  const usage = usageQuery.data;

  return <div className="admin-page phase05-page usage-admin-page"><AdminTabs active="usage" /><AdminPageHeader overline="AI USAGE" title="用量" description="展示当前 Workspace 的真实 AI 调用、Token、Fallback 与成本快照；不生成虚构 KPI。" />{usageQuery.isLoading ? <LoadingState label="正在读取用量快照…" /> : usageQuery.isError ? <ErrorState message={errorMessage(usageQuery.error)} /> : !usage ? <EmptyState title="暂无用量快照" detail="服务端尚未返回当前 Workspace 的 AI usage 数据。" /> : <><div className="metric-grid admin-metrics phase05-metrics"><article><span>调用次数</span><strong>{usage.calls}</strong><small>AI invocations</small></article><article><span>Input Tokens</span><strong>{usage.inputTokens}</strong><small>累计输入</small></article><article><span>Output Tokens</span><strong>{usage.outputTokens}</strong><small>累计输出</small></article><article><span>Fallback</span><strong className={usage.fallbacks ? 'metric-warm' : 'metric-positive'}>{usage.fallbacks}</strong><small>{usage.failures} 次失败</small></article></div><section className="phase05-resource-list panel-surface"><div className="phase05-list-heading"><span className="overline">PURPOSE BREAKDOWN</span><span className="quiet-label">估算成本 ¥{usage.estimatedCost}</span></div>{Object.entries(usage.byPurpose).length === 0 ? <div className="table-empty">暂无 purpose 分项。</div> : Object.entries(usage.byPurpose).map(([purpose, item]) => <article className="phase05-list-row" key={purpose}><div><strong>{purpose}</strong><small>{item.calls} calls · {item.inputTokens + item.outputTokens} tokens</small></div><span className="phase05-secondary">失败 {item.failures} · Fallback {item.fallbacks}</span></article>)}</section></>}</div>;
}
