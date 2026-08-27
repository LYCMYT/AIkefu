import { useState } from 'react';
import { deleteCustomerData, type CustomerDataDeletionResult } from '../../api';
import { AdminPageHeader, AdminTabs } from '../admin/AdminChrome';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '删除请求失败。';
}

function shortId(value?: string): string {
  if (!value) return '—';
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;
}

function readableTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
}

export function DataPrivacyPage({ token }: { token: string }) {
  const [buyerId, setBuyerId] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [result, setResult] = useState<CustomerDataDeletionResult>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const canDelete = buyerId.trim().length > 0 && confirmation.trim().toUpperCase() === 'DELETE' && !busy;

  const submitDeletion = async () => {
    if (!canDelete) return setNotice('请输入买家 ID，并输入 DELETE 完成二次确认。');
    setBusy(true);
    setNotice('');
    setResult(undefined);
    try {
      const next = await deleteCustomerData(token, buyerId.trim());
      setResult(next);
      setConfirmation('');
      setNotice('客户数据删除与匿名化已完成。');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return <div className="admin-page phase05-page privacy-page"><AdminTabs active="privacy" /><AdminPageHeader overline="DATA & PRIVACY" title="数据与隐私" description="在当前匿名 Demo Workspace 内执行 Delete Customer Data；服务端结果是唯一事实来源。" />
    <div className="privacy-layout"><section className="privacy-danger-card panel-surface" aria-labelledby="customer-data-delete-heading"><div className="privacy-card-heading"><div><span className="overline">DESTRUCTIVE ACTION</span><h3 id="customer-data-delete-heading">删除客户数据</h3></div><span className="status-badge is-danger">不可撤销</span></div><p className="privacy-lead">此操作会删除客户的聊天、图片、人工记忆与关联候选知识，并匿名化可识别的买家和订单字段。匿名聚合统计与无法反推个人的审计事实会保留。</p><div className="privacy-scope-grid"><div><span className="overline">DELETE</span><strong>聊天 · 附件 · Memory · Candidate</strong><small>删除后 AI 不得继续读取旧 CustomerMemory。</small></div><div><span className="overline">ANONYMIZE</span><strong>Buyer · Order identifiers</strong><small>保留金额、状态和时间等不可识别业务聚合。</small></div><div><span className="overline">PRESERVE</span><strong>匿名聚合 · Audit facts</strong><small>不保留完整聊天、手机号、地址、Token 或 Cookie。</small></div></div><div className="privacy-form"><label className="compact-field"><span>输入买家 ID</span><input value={buyerId} onChange={(event) => { setBuyerId(event.currentTarget.value); setResult(undefined); }} placeholder="例如 buyer-demo-001" aria-label="输入买家 ID" autoComplete="off" /></label><label className="compact-field"><span>二次确认</span><input value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} placeholder="输入 DELETE 以继续" aria-label="二次确认，输入 DELETE" autoComplete="off" /></label><p className="privacy-confirmation-hint">为避免误操作，请输入大写 <code>DELETE</code>。仅提交当前 Workspace 的买家 ID。</p><button className="danger-button privacy-submit" type="button" onClick={() => void submitDeletion()} disabled={!canDelete}>{busy ? '删除处理中…' : '确认删除并匿名化'}</button></div>{notice && <div className={`inline-notice ${notice.includes('失败') || notice.includes('不可用') ? '' : 'is-success'}`} role="status">{notice}</div>}</section>
      <section className="privacy-retention-card panel-surface" aria-labelledby="retention-heading"><div className="privacy-card-heading"><div><span className="overline">RETENTION POLICY</span><h3 id="retention-heading">数据保留规则</h3></div><span className="observe-only">FROZEN V1</span></div><div className="retention-list"><div><strong>聊天原文 · 45 天</strong><span>Conversation 原始聊天</span></div><div><strong>图片原件 · 15 天</strong><span>对象存储原图</span></div><div><strong>ConversationSummary · 90 天</strong><span>摘要保留窗口</span></div><div><strong>CustomerMemory · 人工管理 / expiresAt</strong><span>不自动提取长期记忆</span></div><div><strong>企业知识 · 版本 / 状态 / 有效期</strong><span>按知识治理策略管理</span></div><div><strong>AuditLog · 最小化脱敏长期保留</strong><span>仅保留无法反推个人的事实</span></div></div></section></div>
    {result && <section className="privacy-result-card panel-surface" aria-live="polite"><div className="privacy-card-heading"><div><span className="overline">DELETION RECEIPT</span><h3>删除结果</h3></div><span className="status-badge is-positive">{result.status}</span></div><p className="privacy-result-meta">买家请求 {shortId(result.buyerId)} · 完成于 {readableTime(result.completedAt)}</p><div className="privacy-result-columns"><div><span className="overline">DELETED</span><p>Conversation <strong>{result.deleted.conversations}</strong> · Message <strong>{result.deleted.messages}</strong> · Attachment <strong>{result.deleted.attachments}</strong></p><p>CustomerMemory <strong>{result.deleted.customerMemories}</strong> · Candidate <strong>{result.deleted.knowledgeCandidates}</strong></p></div><div><span className="overline">ANONYMIZED</span><p>Buyer <strong>{result.anonymized.buyers}</strong> · Order <strong>{result.anonymized.orders}</strong></p></div><div><span className="overline">PRESERVED</span><p>Anonymous aggregate <strong>{result.preserved.anonymousAggregates}</strong> · Audit fact <strong>{result.preserved.auditFacts}</strong></p></div></div></section>}
  </div>;
}
