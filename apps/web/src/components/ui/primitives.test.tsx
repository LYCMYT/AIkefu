import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Badge, Button, Card, ConfirmDialog, Drawer, PageHeader, SegmentedTabs, StatusBadge } from './primitives';

describe('frontend design-system primitives', () => {
  it('renders shared controls with stable product classes and accessible states', () => {
    const html = renderToStaticMarkup(
      <>
        <PageHeader eyebrow="运营后台" title="知识库" description="管理当前店铺知识" />
        <Card><Button variant="primary">保存</Button><Badge>3</Badge><StatusBadge tone="success">已连接</StatusBadge></Card>
        <SegmentedTabs label="知识视图" value="formal" items={[{ value: 'formal', label: '正式知识' }, { value: 'candidate', label: '候选知识' }]} onChange={() => undefined} />
        <Drawer open title="业务上下文" onClose={() => undefined}><span>详情</span></Drawer>
        <ConfirmDialog open title="删除知识" description="该操作不可撤销" confirmLabel="确认删除" onCancel={() => undefined} onConfirm={() => undefined} />
      </>,
    );

    expect(html).toContain('ui-page-header');
    expect(html).toContain('ui-button is-primary');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('确认删除');
  });

  it('omits a closed drawer from the accessibility tree', () => {
    expect(renderToStaticMarkup(<Drawer open={false} title="详情" onClose={() => undefined}>内容</Drawer>)).toBe('');
  });
});
