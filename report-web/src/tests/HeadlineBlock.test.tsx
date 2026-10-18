import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HeadlineBlock } from '../components/HeadlineBlock';
import type { AnomalyRow } from '../api/types';

describe('HeadlineBlock', () => {
  let mockAnomalies: AnomalyRow[] = [];

  beforeEach(() => {
    mockAnomalies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('anomalies')) {
          return new Response(
            JSON.stringify({
              schema_version: '1.0',
              checked_at: '2026-08-29T10:00:00+00:00',
              count: mockAnomalies.length,
              anomalies: mockAnomalies,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('{}', { status: 200 });
      })
    );
  });

  function renderHeadline(props: Partial<Parameters<typeof HeadlineBlock>[0]> = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    return render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <HeadlineBlock
            netWorth="320000.00"
            totalAssets="350000.00"
            totalLiabilities="30000.00"
            availableCash="50000.00"
            currency="CNY"
            prevNetWorth="310000.00"
            {...props}
          />
        </QueryClientProvider>
      </MemoryRouter>
    );
  }

  it('anomalies 为空时，不渲染 alert affordance', async () => {
    mockAnomalies = [];
    renderHeadline();
    expect(await screen.findByText('320,000.00')).toBeInTheDocument();
    expect(screen.queryByText(/个待处理/)).not.toBeInTheDocument();
  });

  it('anomalies ≥ 1 时，渲染 alert affordance 且包含正确的文案与 a11y 属性', async () => {
    mockAnomalies = [
      {
        id: 'anomaly:1',
        source: 'spending_trend',
        severity: 'warning',
        message: '超支',
        category: '餐饮',
        amount: '1000.00',
        currency: 'CNY',
      },
    ];
    renderHeadline();
    const link = await screen.findByRole('link', { name: '有 1 个待处理异常，点击查看' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/alerts');
    expect(link).toHaveTextContent('1 个待处理');
  });

  it('存在多个异常时正确统计 N 个待处理', async () => {
    mockAnomalies = [
      { id: '1', source: 's1', severity: 'critical', message: 'c1', category: null, amount: null, currency: null },
      { id: '2', source: 's2', severity: 'warning', message: 'w1', category: null, amount: null, currency: null },
      { id: '3', source: 's3', severity: 'info', message: 'i1', category: null, amount: null, currency: null },
    ];
    renderHeadline();
    const link = await screen.findByRole('link', { name: '有 3 个待处理异常，点击查看' });
    expect(link).toHaveTextContent('3 个待处理');
  });

  it('基础指标与 delta 正确渲染', async () => {
    renderHeadline();
    expect(await screen.findByText('320,000.00')).toBeInTheDocument();
    expect(screen.getByText('总资产')).toBeInTheDocument();
    expect(screen.getByText('总负债')).toBeInTheDocument();
    expect(screen.getByText('可用现金')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // UX-01：fx_complete=false 时首页 Headline 必须解释「为什么是 —」
  // -------------------------------------------------------------------------
  describe('FX 缺失副文案 (UX-01)', () => {
    it('fx_complete=false 且列出缺失币种 → 渲染「缺少 X、Y 汇率，相关金额未计入」', async () => {
      renderHeadline({ fxComplete: false, missingCurrencies: ['CHF', 'EUR'] });
      const note = await screen.findByTestId('headline-fx-note');
      expect(note).toHaveTextContent('缺少 CHF、EUR 汇率，相关金额未计入');
    });

    it('fx_complete=false 但后端未给币种清单 → 仍披露缺失，不臆造币种', async () => {
      renderHeadline({ fxComplete: false, missingCurrencies: [] });
      const note = await screen.findByTestId('headline-fx-note');
      expect(note).toHaveTextContent('缺少汇率，相关金额未计入');
      expect(note.textContent).not.toMatch(/[A-Z]{3}/);
    });

    it('fx_complete=true → 不渲染副文案（避免把完整数据说成缺失）', async () => {
      renderHeadline({ fxComplete: true, missingCurrencies: [] });
      expect(await screen.findByText('320,000.00')).toBeInTheDocument();
      expect(screen.queryByTestId('headline-fx-note')).toBeNull();
    });

    it('未传 fx 字段（旧调用形态）→ 不渲染副文案', async () => {
      renderHeadline();
      expect(await screen.findByText('320,000.00')).toBeInTheDocument();
      expect(screen.queryByTestId('headline-fx-note')).toBeNull();
    });

    it('副文案只含币种代码，遮蔽模式下同样不泄漏金额', async () => {
      renderHeadline({ fxComplete: false, missingCurrencies: ['CHF'] });
      const note = await screen.findByTestId('headline-fx-note');
      expect(note.textContent).not.toMatch(/\d{1,3}(,\d{3})*\.\d{2}/);
    });
  });
});
