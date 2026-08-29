import { useState } from 'react';
import { Bot, Boxes, BrainCircuit, CheckCircle2, GitBranch, Plus, RotateCcw, ShieldCheck, Store, X } from 'lucide-react';
import type { CreateShopInput } from '../../api';
import { Button, IconButton } from '../../components/ui/primitives';

const capabilities = [
  { icon: Boxes, title: '多店铺管理', detail: '在同一个演示空间中切换店铺，会话、商品与知识始终按店铺隔离。' },
  { icon: ShieldCheck, title: 'AI 安全分级', detail: '低风险任务可以自动回复，高风险或证据不足的任务自动转人工。' },
  { icon: BrainCircuit, title: '商品自动学习', detail: '添加店铺后自动整理商品资料，并持续展示真实学习任务进度。' },
  { icon: CheckCircle2, title: '知识与 Evidence', detail: '回复依据可追溯到商品、订单与知识版本，避免无来源回答。' },
  { icon: GitBranch, title: 'Workflow 与审批', detail: '用可发布的工作流编排动作，对高风险操作保留人工审批。' },
  { icon: RotateCcw, title: '恢复与场景测试', detail: '通过幂等任务、错误治理和场景实验验证异常后的恢复能力。' },
] as const;

export interface EmptyStoreHomeProps {
  busy: boolean;
  error: string;
  onCreate: (input: CreateShopInput) => Promise<void>;
}

export function EmptyStoreHome({ busy, error, onCreate }: EmptyStoreHomeProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [templateKey, setTemplateKey] = useState<'FASHION_DEMO' | 'TECH_DEMO'>('FASHION_DEMO');

  const submit = async () => {
    await onCreate({ platform: 'DOUYIN_DEMO', templateKey, name: name.trim() || undefined, aiMode: 'AUTO_ALLOWED' });
  };

  return <div className="empty-store-home">
    <section className="empty-store-hero">
      <div className="empty-store-hero-copy"><span className="workbench-eyebrow"><Bot aria-hidden="true" size={16} />AIkefu 演示空间</span><h2>添加第一家店铺，让 AI 客服开始工作</h2><p>这里展示的每项能力都连接真实业务状态。添加 MockDouyin 演示店铺后，系统会准备商品、订单与知识，并自动开始商品学习。</p><Button className="empty-store-primary" onClick={() => setOpen(true)} variant="primary"><Plus aria-hidden="true" size={18} />添加店铺</Button><small>本地合成数据，不会连接或修改真实抖音店铺。</small></div>
      <div className="empty-store-visual" aria-hidden="true"><span className="empty-store-orbit"><Store size={38} /></span><div><strong>店铺</strong><i /><strong>商品学习</strong><i /><strong>安全回复</strong></div></div>
    </section>
    <section aria-labelledby="capabilities-heading" className="workbench-capabilities"><div className="workbench-section-heading"><span>真实能力</span><h3 id="capabilities-heading">从接入到回复，一条完整的演示链路</h3></div><div className="workbench-capability-grid">{capabilities.map(({ icon: Icon, title, detail }) => <article className="workbench-capability-card" key={title}><span><Icon aria-hidden="true" size={21} /></span><h4>{title}</h4><p>{detail}</p></article>)}</div></section>
    {open && <div className="store-create-layer"><button aria-label="关闭添加店铺" className="store-create-backdrop" disabled={busy} onClick={() => setOpen(false)} type="button" /><section aria-labelledby="store-create-heading" aria-modal="true" className="store-create-dialog" role="dialog"><header><div><span>ADD DEMO SHOP</span><h2 id="store-create-heading">添加店铺</h2><p>选择合成模板，创建后会直接进入店铺工作台。</p></div><IconButton disabled={busy} label="关闭添加店铺" onClick={() => setOpen(false)}><X aria-hidden="true" size={18} /></IconButton></header><div className="store-create-body"><label><span>店铺名称</span><input aria-label="店铺名称" maxLength={40} onChange={(event) => setName(event.currentTarget.value)} placeholder="例如：我的服饰演示店" value={name} /></label><fieldset><legend>演示模板</legend><label className={templateKey === 'FASHION_DEMO' ? 'is-selected' : ''}><input checked={templateKey === 'FASHION_DEMO'} name="shop-template" onChange={() => setTemplateKey('FASHION_DEMO')} type="radio" /><span><strong>服饰店</strong><small>尺码、库存、物流与售后场景</small></span></label><label className={templateKey === 'TECH_DEMO' ? 'is-selected' : ''}><input checked={templateKey === 'TECH_DEMO'} name="shop-template" onChange={() => setTemplateKey('TECH_DEMO')} type="radio" /><span><strong>数码店</strong><small>规格、库存、发货与商品推荐场景</small></span></label></fieldset><div className="store-create-facts"><span><strong>平台</strong>MockDouyin 演示环境</span><span><strong>AI</strong>创建后开启，准备完成前不会自动发送</span></div>{error && <p className="inline-error" role="alert">{error}</p>}</div><footer><Button disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button disabled={busy} onClick={() => void submit()} variant="primary">{busy ? '正在创建…' : '添加并进入工作台'}</Button></footer></section></div>}
  </div>;
}
