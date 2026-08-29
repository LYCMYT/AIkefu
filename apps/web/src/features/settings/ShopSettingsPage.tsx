import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle2, PackageCheck, Save, ShieldAlert } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { AppPath } from '../../app/routes';
import { getProductLearningJobs, getShopSettings, updateShopSettings, type ProductLearningJob, type ShopSettings, type ShopSettingsInput, type ShopSummary } from '../../api';
import { Button, StatusBadge } from '../../components/ui/primitives';
import { errorMessage, learningProgress, learningStatusLabel } from '../shared/view-models';

interface ShopSettingsPageProps {
  token: string;
  shops: ShopSummary[];
  shopId: string;
  refreshKey: number;
  onDirtyChange?: (dirty: boolean) => void;
  onNavigate?: (path: AppPath) => void;
  onFoundationRefresh?: () => Promise<void> | void;
}

const blankSettings: ShopSettingsInput = {
  tone: '', logisticsPolicy: '', shippingPolicy: '', afterSalesPolicy: '', welcomeMessage: '',
  closingMessages: { NO_ORDER: '', WAITING_SHIPMENT: '', SHIPPED: '', COMPLETED: '' },
  transferKeywords: [], forbiddenTerms: [],
};

function normalizedSettings(value: ShopSettings): ShopSettingsInput {
  return {
    tone: value.tone ?? '', logisticsPolicy: value.logisticsPolicy ?? '', shippingPolicy: value.shippingPolicy ?? '', afterSalesPolicy: value.afterSalesPolicy ?? '', welcomeMessage: value.welcomeMessage ?? '',
    closingMessages: value.closingMessages ?? {}, transferKeywords: value.transferKeywords ?? [], forbiddenTerms: value.forbiddenTerms ?? [],
  };
}

export function ShopSettingsPage({ token, shops, shopId, refreshKey, onDirtyChange, onNavigate, onFoundationRefresh }: ShopSettingsPageProps) {
  const navigate = useNavigate();
  const shop = shops.find((item) => item.id === shopId);
  const [form, setForm] = useState<ShopSettingsInput>(blankSettings);
  const [baseline, setBaseline] = useState('');
  const [keywordText, setKeywordText] = useState('');
  const [forbiddenText, setForbiddenText] = useState('');
  const [job, setJob] = useState<ProductLearningJob>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [settingsConfirmed, setSettingsConfirmed] = useState(false);
  const dirty = useMemo(() => baseline !== '' && baseline !== JSON.stringify(form), [baseline, form]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setNotice('');
    getShopSettings(token, shopId).then((settings) => {
      if (!mounted) return;
      const next = normalizedSettings(settings);
      setForm(next);
      setBaseline(JSON.stringify(next));
      setKeywordText(next.transferKeywords.join('\n'));
      setForbiddenText(next.forbiddenTerms.map((rule) => `${rule.term} => ${rule.replacement}`).join('\n'));
      setSettingsConfirmed(settings.settingsConfirmed === true);
    }).catch((error) => { if (mounted) setNotice(errorMessage(error)); }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [shopId, token]);

  useEffect(() => {
    let mounted = true;
    getProductLearningJobs(token, shopId)
      .then((jobs) => { if (mounted) setJob(jobs[0]); })
      .catch(() => { if (mounted) setJob(undefined); });
    return () => { mounted = false; };
  }, [refreshKey, shopId, token]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  const patch = <K extends keyof ShopSettingsInput>(key: K, value: ShopSettingsInput[K]) => setForm((current) => ({ ...current, [key]: value }));
  const updateClosing = (key: string, value: string) => patch('closingMessages', { ...form.closingMessages, [key]: value });
  const back = () => {
    const nextPath = `/workbench/shops/${encodeURIComponent(shopId)}` as AppPath;
    if (onNavigate) {
      onNavigate(nextPath);
      return;
    }
    if (dirty && !window.confirm('设置尚未保存，确认离开吗？')) return;
    navigate(nextPath);
  };
  const save = async () => {
    setSaving(true);
    setNotice('');
    const next: ShopSettingsInput = {
      ...form,
      transferKeywords: keywordText.split(/[,，\n]/).map((value) => value.trim()).filter(Boolean),
      forbiddenTerms: forbiddenText.split('\n').map((line) => { const [term = '', replacement = ''] = line.split(/=>|→/); return { term: term.trim(), replacement: replacement.trim() }; }).filter((rule) => rule.term),
    };
    try {
      const saved = normalizedSettings(await updateShopSettings(token, shopId, next));
      setForm(saved); setBaseline(JSON.stringify(saved));
      setKeywordText(saved.transferKeywords.join('\n'));
      setForbiddenText(saved.forbiddenTerms.map((rule) => `${rule.term} => ${rule.replacement}`).join('\n'));
    setNotice('设置已确认，商品学习完成后 AI 才会自动回复。');
      setSettingsConfirmed(true);
      await onFoundationRefresh?.();
      window.dispatchEvent(new Event('aikefu:foundation-refresh'));
    } catch (error) { setNotice(errorMessage(error)); }
    finally { setSaving(false); }
  };

  const progress = learningProgress(job, []);
  return <div className="shop-settings-page">
    <header className="shop-settings-header"><button className="settings-back" onClick={back} type="button"><ArrowLeft aria-hidden="true" size={18} />返回店铺</button><div><span>SHOP SETTINGS · MOCKDOUYIN</span><h2>基础设置</h2><p>{shop?.name ?? '当前店铺'} · 设置直接参与欢迎语、转人工与安全校验。</p></div><Button disabled={(settingsConfirmed && !dirty) || saving || loading} onClick={() => void save()} variant="primary"><Save aria-hidden="true" size={17} />{saving ? '保存中…' : settingsConfirmed ? '保存设置' : '确认并启用 AI'}</Button></header>
    {!loading && !settingsConfirmed && <div className="settings-notice" role="status">请检查模板带入的店铺政策。保存确认前，即使商品学习完成，AI 也不会自动发送。</div>}
    {notice && <div className={`settings-notice ${notice.includes('已保存') ? 'is-success' : ''}`} role="status">{notice}</div>}
    {loading ? <section className="settings-loading panel-surface"><span className="loading-spinner" /><p>正在读取店铺设置…</p></section> : <div className="shop-settings-layout"><main className="shop-settings-form">
      <section className="settings-section panel-surface"><header><span className="settings-section-icon"><CheckCircle2 size={19} /></span><div><h3>客服风格与欢迎语</h3><p>描述表达风格，并设置买家首次进入会话时看到的欢迎内容。</p></div></header><div className="settings-field-grid"><label><span>客服语气</span><input value={form.tone} onChange={(event) => patch('tone', event.currentTarget.value)} /></label><label className="is-wide"><span>进线欢迎语</span><textarea rows={3} value={form.welcomeMessage} onChange={(event) => patch('welcomeMessage', event.currentTarget.value)} /></label></div></section>
      <section className="settings-section panel-surface"><header><span className="settings-section-icon"><PackageCheck size={19} /></span><div><h3>履约与售后政策</h3><p>这些内容是稳定店铺政策；订单实时状态仍以订单事实为准。</p></div></header><div className="settings-field-grid"><label className="is-wide"><span>物流政策</span><textarea rows={3} value={form.logisticsPolicy} onChange={(event) => patch('logisticsPolicy', event.currentTarget.value)} /></label><label className="is-wide"><span>发货政策</span><textarea rows={3} value={form.shippingPolicy} onChange={(event) => patch('shippingPolicy', event.currentTarget.value)} /></label><label className="is-wide"><span>售后政策</span><textarea rows={3} value={form.afterSalesPolicy} onChange={(event) => patch('afterSalesPolicy', event.currentTarget.value)} /></label></div></section>
      <section className="settings-section panel-surface"><header><span className="settings-section-icon"><CheckCircle2 size={19} /></span><div><h3>会话结束语</h3><p>根据订单阶段使用不同收尾文案。</p></div></header><div className="settings-field-grid">{([['NO_ORDER', '暂无订单'], ['WAITING_SHIPMENT', '等待发货'], ['SHIPPED', '已经发货'], ['COMPLETED', '订单完成']] as const).map(([key, label]) => <label key={key}><span>{label}</span><textarea rows={3} value={form.closingMessages[key] ?? ''} onChange={(event) => updateClosing(key, event.currentTarget.value)} /></label>)}</div></section>
      <section className="settings-section panel-surface"><header><span className="settings-section-icon is-warning"><ShieldAlert size={19} /></span><div><h3>转人工与违禁词</h3><p>每行一个关键词；违禁词使用“原词 =&gt; 替换词”。</p></div></header><div className="settings-field-grid"><label><span>转人工关键词</span><textarea rows={7} value={keywordText} onChange={(event) => { setKeywordText(event.currentTarget.value); patch('transferKeywords', event.currentTarget.value.split(/[,，\n]/).map((value) => value.trim()).filter(Boolean)); }} /></label><label><span>违禁词替换规则</span><textarea rows={7} value={forbiddenText} onChange={(event) => { setForbiddenText(event.currentTarget.value); patch('forbiddenTerms', event.currentTarget.value.split('\n').map((line) => { const [term = '', replacement = ''] = line.split(/=>|→/); return { term: term.trim(), replacement: replacement.trim() }; }).filter((rule) => rule.term)); }} /></label></div></section>
    </main><aside className="settings-status-rail"><section className="settings-learning-card panel-surface"><div className="settings-learning-heading"><span><PackageCheck size={18} /></span><div><small>商品学习</small><strong>{learningStatusLabel(job?.status)}</strong></div><StatusBadge tone={job?.status === 'SUCCEEDED' ? 'success' : job?.status === 'FAILED' || job?.status === 'PARTIAL_SUCCESS' ? 'danger' : 'warning'}>{progress}%</StatusBadge></div><div className="settings-progress"><i style={{ width: `${progress}%` }} /></div><p>{job ? `${job.completed ?? 0} / ${job.total ?? 0} 个商品完成` : '创建店铺后，学习任务会自动开始。'}</p>{(job?.failed ?? 0) > 0 && <Button onClick={() => onNavigate ? onNavigate('/admin/products') : navigate('/admin/products')}>查看失败商品</Button>}</section><section className="settings-scope-note"><strong>数据边界</strong><p>所有设置仅作用于当前 Workspace 与店铺，不会连接真实抖音。</p></section></aside></div>}
  </div>;
}
