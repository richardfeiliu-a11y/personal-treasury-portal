import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HealthSignalsStrip } from '../components/HealthSignalsStrip';
import type { AnomalyRow } from '../api/types';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('HealthSignalsStrip', () => {
  it('anomalies 为空时完全隐藏，返回 null', () => {
    const { container } = render(
      <MemoryRouter>
        <HealthSignalsStrip anomalies={[]} />
      </MemoryRouter>
    );
    expect(container.firstChild).toBeNull();
  });

  it('anomalies 仅包含 non-critical (warning / info) 时完全隐藏，返回 null', () => {
    const nonCriticalAnomalies: AnomalyRow[] = [
      { id: '1', source: 's1', severity: 'warning', message: 'w1', category: null, amount: null, currency: null },
      { id: '2', source: 's2', severity: 'info', message: 'i1', category: null, amount: null, currency: null },
    ];
    const { container } = render(
      <MemoryRouter>
        <HealthSignalsStrip anomalies={nonCriticalAnomalies} />
      </MemoryRouter>
    );
    expect(container.firstChild).toBeNull();
  });

  it('anomalies 包含 critical 时渲染 3px 左边框样式与「有 N 个请关注」文案', () => {
    const criticalAnomalies: AnomalyRow[] = [
      { id: '1', source: 's1', severity: 'critical', message: 'c1', category: null, amount: null, currency: null },
      { id: '2', source: 's2', severity: 'critical', message: 'c2', category: null, amount: null, currency: null },
      { id: '3', source: 's3', severity: 'warning', message: 'w1', category: null, amount: null, currency: null },
    ];
    render(
      <MemoryRouter>
        <HealthSignalsStrip anomalies={criticalAnomalies} />
      </MemoryRouter>
    );

    const strip = screen.getByRole('link', { name: '财务健康信号' });
    expect(strip).toBeInTheDocument();
    expect(strip).toHaveClass('health-signals-strip--critical');
    expect(screen.getByText('有 2 个请关注')).toBeInTheDocument();
  });

  it('点击或回车键导航至 /alerts', () => {
    mockNavigate.mockClear();
    const criticalAnomalies: AnomalyRow[] = [
      { id: '1', source: 's1', severity: 'critical', message: 'c1', category: null, amount: null, currency: null },
    ];
    render(
      <MemoryRouter>
        <HealthSignalsStrip anomalies={criticalAnomalies} />
      </MemoryRouter>
    );

    const strip = screen.getByRole('link', { name: '财务健康信号' });
    fireEvent.click(strip);
    expect(mockNavigate).toHaveBeenCalledWith('/alerts');

    mockNavigate.mockClear();
    fireEvent.keyDown(strip, { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/alerts');
  });
});
