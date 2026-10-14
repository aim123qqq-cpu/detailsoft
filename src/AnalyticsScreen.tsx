import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { AnalyticsOverview, WorkOrder } from './types';

const statusLabels: Record<WorkOrder['status'], string> = {
  INTAKE: 'Приёмка',
  ESTIMATE_DRAFT: 'Смета',
  APPROVED: 'Согласован',
  IN_PROGRESS: 'В работе',
  QC: 'Контроль',
  READY: 'Готов',
  CLOSED: 'Закрыт'
};

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function rangeFor(days: number) {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days + 1);
  return { from: dateKey(from), to: dateKey(to) };
}

const money = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

export function AnalyticsScreen() {
  const [days, setDays] = useState(30);
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const range = useMemo(() => rangeFor(days), [days]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api.getAnalyticsOverview(range.from, range.to, controller.signal)
      .then(setOverview)
      .catch((requestError) => {
        if ((requestError as Error).name !== 'AbortError') setError((requestError as Error).message);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [range, retry]);

  const chartDays = overview?.daily.slice(-14) ?? [];
  const chartMax = Math.max(1, ...chartDays.map((item) => item.bookings + item.orders));
  const statusMax = Math.max(1, ...(overview?.orderStatuses.map((item) => item.count) ?? []));

  return (
    <section className="screen analytics-screen" data-testid="analytics-screen">
      <div className="analytics-intro">
        <span>Операционная сводка</span>
        <h2>Пульс центра</h2>
        <p>Записи, заказы и выполнение работ в одном месте.</p>
        <div className="analytics-period" aria-label="Период аналитики">
          {[7, 30, 90].map((item) => (
            <button key={item} className={days === item ? 'selected' : ''} onClick={() => setDays(item)}>{item} дней</button>
          ))}
        </div>
      </div>

      {loading && <div className="workspace-state"><i className="spinner"/> Загружаем показатели…</div>}
      {error && <div className="workspace-state error"><strong>Не удалось загрузить аналитику</strong><span>{error}</span><button onClick={() => setRetry((current) => current + 1)}>Повторить</button></div>}

      {!loading && !error && overview && <>
        <div className="analytics-range">{shortDate.format(new Date(`${overview.period.from}T12:00:00`))} — {shortDate.format(new Date(`${overview.period.to}T12:00:00`))}</div>
        <div className="analytics-kpis">
          <article className="analytics-kpi accent"><small>Заказы</small><strong>{overview.orders.total}</strong><span>{overview.orders.active} активных</span></article>
          <article className="analytics-kpi"><small>Записи</small><strong>{overview.bookings.total}</strong><span>{overview.bookings.cancelled} отменено</span></article>
          <article className="analytics-kpi"><small>Закрыто</small><strong>{overview.orders.closed}</strong><span>{overview.orders.ready} готовы</span></article>
          <article className="analytics-kpi wide"><small>Согласовано по сметам</small><strong>{money.format(overview.orders.approvedEstimateAmountMinor / 100)} ₽</strong><span>Операционный объём согласованных работ</span></article>
        </div>

        <section className="analytics-card">
          <div className="analytics-card-head"><div><small>Динамика</small><h3>Активность по дням</h3></div><span><i/> записи <i/> заказы</span></div>
          <div className="activity-chart" aria-label="График записей и заказов">
            {chartDays.map((item) => <div className="activity-day" key={item.date} title={`${item.date}: ${item.bookings} записей, ${item.orders} заказов`}>
              <div><i style={{ height: `${Math.max(item.bookings ? 10 : 2, item.bookings / chartMax * 100)}%` }}/><b style={{ height: `${Math.max(item.orders ? 10 : 2, item.orders / chartMax * 100)}%` }}/></div>
              <span>{new Date(`${item.date}T12:00:00`).getDate()}</span>
            </div>)}
          </div>
        </section>

        <section className="analytics-card">
          <div className="analytics-card-head"><div><small>Воронка</small><h3>Статусы заказов</h3></div><b>{overview.orders.total}</b></div>
          <div className="status-bars">
            {overview.orderStatuses.length === 0 && <p>За выбранный период заказов нет.</p>}
            {overview.orderStatuses.map((item) => <div key={item.status}>
              <span>{statusLabels[item.status]}</span><i><b style={{ width: `${item.count / statusMax * 100}%` }}/></i><strong>{item.count}</strong>
            </div>)}
          </div>
        </section>

        <section className="operations-summary">
          <div><small>Выполнение операций</small><strong>{overview.operations.completionPercent}%</strong></div>
          <i><b style={{ width: `${overview.operations.completionPercent}%` }}/></i>
          <p>{overview.operations.done} из {overview.operations.total} выполнено · {overview.operations.blocked} заблокировано</p>
        </section>
      </>}
    </section>
  );
}
