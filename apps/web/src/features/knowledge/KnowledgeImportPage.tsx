import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, Download, FileSpreadsheet, Upload, XCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { commitKnowledgeImport, previewKnowledgeImport, type KnowledgeImportPreview, type KnowledgeImportRow, type ShopSummary } from '../../api';
import { Button, StatusBadge } from '../../components/ui/primitives';
import { errorMessage } from '../shared/view-models';

interface KnowledgeImportPageProps {
  token: string;
  shops: ShopSummary[];
  shopId: string;
}

function normalizedStatus(row: KnowledgeImportRow): 'READY' | 'DUPLICATE' | 'CONFLICT' | 'ERROR' {
  const value = String(row.status).toUpperCase();
  if (value === 'DUPLICATE' || value === 'CONFLICT' || value === 'ERROR') return value;
  return 'READY';
}

const labels = { READY: '可导入', DUPLICATE: '重复', CONFLICT: '冲突', ERROR: '错误' } as const;

export function KnowledgeImportPage({ token, shops, shopId }: KnowledgeImportPageProps) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const shop = shops.find((item) => item.id === shopId);
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<KnowledgeImportPreview>();
  const [busy, setBusy] = useState<'preview' | 'commit' | ''>('');
  const [notice, setNotice] = useState('');
  const [done, setDone] = useState(false);
  const counts = useMemo(() => {
    if (preview?.counts) return { READY: preview.counts.ready, DUPLICATE: preview.counts.duplicate, CONFLICT: preview.counts.conflict, ERROR: preview.counts.error };
    return (preview?.rows ?? []).reduce((result, row) => { result[normalizedStatus(row)] += 1; return result; }, { READY: 0, DUPLICATE: 0, CONFLICT: 0, ERROR: 0 });
  }, [preview]);

  const choose = async (next?: File) => {
    if (!next) return;
    setFile(next); setPreview(undefined); setDone(false); setNotice(''); setBusy('preview');
    try { const result = await previewKnowledgeImport(token, next, shopId); setPreview(result); setNotice(result.rows.length ? '服务端校验完成，请确认行级结果。' : '导入任务已创建，服务端正在生成预览。'); }
    catch (error) { setNotice(errorMessage(error)); }
    finally { setBusy(''); }
  };
  const commit = async () => {
    if (!preview?.id) return;
    setBusy('commit'); setNotice('');
    try { const result = await commitKnowledgeImport(token, preview.id, shopId); setPreview(result); setDone(true); setNotice('可导入行已提交；重复、冲突和错误行仍保持隔离。'); }
    catch (error) { setNotice(errorMessage(error)); }
    finally { setBusy(''); }
  };

  return <div className="dedicated-import-page">
    <header className="import-page-header"><button onClick={() => navigate(`/workbench/shops/${encodeURIComponent(shopId)}`)} type="button"><ArrowLeft size={18} />返回店铺</button><div><span>KNOWLEDGE IMPORT</span><h2>导入知识</h2><p>{shop?.name ?? '当前店铺'} · 文件会先预览和校验，确认后才写入正式知识。</p></div><a download href="/seed/knowledge-import-template.csv"><Download size={17} />下载模板</a></header>
    <section className="import-upload-card panel-surface"><input accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="选择知识文件" hidden onChange={(event) => void choose(event.currentTarget.files?.[0])} ref={inputRef} type="file" /><button className="import-dropzone" disabled={busy !== ''} onClick={() => inputRef.current?.click()} type="button"><span><Upload size={24} /></span><strong>{file?.name ?? '选择 Excel / CSV 文件'}</strong><small>点击上传；服务端会再次校验店铺范围、重复项、冲突与行格式。</small></button>{busy === 'preview' && <div className="import-processing"><span className="loading-spinner" />正在生成预览…</div>}</section>
    <section aria-label="导入统计" className="import-count-grid">{(Object.keys(labels) as Array<keyof typeof labels>).map((status) => <article className={`import-count is-${status.toLowerCase()}`} key={status}><span>{status === 'READY' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}{labels[status]}</span><strong>{counts[status]}</strong></article>)}</section>
    {notice && <div className={`settings-notice ${done ? 'is-success' : ''}`} role="status">{notice}</div>}
    <section className="import-preview-card panel-surface"><header><div><span>ROW PREVIEW</span><h3>行级校验结果</h3></div><StatusBadge tone={done ? 'success' : preview ? 'info' : 'neutral'}>{done ? '已提交' : preview?.status ?? '等待文件'}</StatusBadge></header><div className="import-preview-scroll"><table><thead><tr><th>行</th><th>商品 ID</th><th>问题</th><th>答案</th><th>范围</th><th>结果</th></tr></thead><tbody>{!preview ? <tr><td colSpan={6} className="table-empty">选择文件后，这里会展示真实校验结果。</td></tr> : preview.rows.length === 0 ? <tr><td colSpan={6} className="table-empty">任务已创建，暂未返回行级快照。</td></tr> : preview.rows.map((row) => { const status = normalizedStatus(row); return <tr key={`${row.rowNumber}-${row.question}`}><td>{row.rowNumber}</td><td>{row.productId || '店铺通用'}</td><td><strong>{row.question}</strong>{row.reason && <small>{row.reason}</small>}</td><td>{row.answer}</td><td>{row.scope}</td><td><span className={`import-row-status is-${status.toLowerCase()}`}>{labels[status]}</span></td></tr>; })}</tbody></table></div><footer><span>{preview ? `任务 ${preview.id}` : '尚未创建导入任务'}</span><Button disabled={!preview?.id || preview.id === 'local-preview' || busy !== '' || done || counts.READY === 0} onClick={() => void commit()} variant="primary">{busy === 'commit' ? '提交中…' : '确认导入可用行'}</Button></footer></section>
  </div>;
}
