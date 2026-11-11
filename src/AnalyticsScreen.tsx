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

  const chartDays = overview?.daily.slice(-30) ?? [];
  const chartMax = Math.max(1, ...chartDays.map((item) => Math.max(item.bookings, item.orders)));
  const statusMax = Math.max(1, ...(overview?.orderStatuses.map((item) => item.count) ?? []));
  const topMax = Math.max(1, ...(overview?.topServices.map((item) => item.count) ?? []));
  const times = (count: number) => `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'раз' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'раза' : 'раз'}`;

  return (
    <section className="screen analytics-screen stats-screen" data-testid="analytics-screen">
      <div className="stats-bar">
        <div><h2>Пульс центра</h2>{overview && <span>{shortDate.format(new Date(`${overview.period.from}T12:00:00`))} — {shortDate.format(new Date(`${overview.period.to}T12:00:00`))}</span>}</div>
        <div className="analytics-period" aria-label="Период аналитики">
          {[7, 30, 90].map((item) => (
            <button key={item} className={days === item ? 'selected' : ''} aria-pressed={days === item} onClick={() => setDays(item)}>{item} дней</button>
          ))}
        </div>
      </div>

      {loading && <div className="workspace-state"><i className="spinner"/> Загружаем показатели…</div>}
      {error && <div className="workspace-state error"><strong>Не удалось загрузить аналитику</strong><span>{error}</span><button onClick={() => setRetry((current) => current + 1)}>Повторить</button></div>}

      {!loading && !error && overview && <>
        <div className="stats-tiles">
          <article className="stats-total"><small>Согласовано по сметам</small><strong>{money.format(overview.orders.approvedEstimateAmountMinor / 100)} ₽</strong>
            <span>{overview.orders.averageApprovedEstimateAmountMinor ? `в среднем ${money.format(overview.orders.averageApprovedEstimateAmountMinor / 100)} ₽ за заказ` : 'согласованных смет пока нет'}</span></article>
          <article className="stats-tile peach"><small>Заказы</small><strong>{overview.orders.total}</strong><span>{overview.orders.active} в работе</span></article>
          <article className="stats-tile sky"><small>Записи</small><strong>{overview.bookings.total}</strong><span>{overview.bookings.cancelled} отменено</span></article>
          <article className="stats-tile sage"><small>Закрыто</small><strong>{overview.orders.closed}</strong><span>{overview.orders.ready} к выдаче</span></article>
        </div>

        <div className="stats-grid">
          <section className="stats-card">
            <div className="stats-card-head"><h3>Активность по дням</h3><span className="stats-legend"><i/> записи <i/> заказы</span></div>
            <div className="stats-chart" aria-label="График записей и заказов">
              {chartDays.map((item, index) => <div className="stats-day" key={item.date} title={`${item.date}: записей ${item.bookings}, заказов ${item.orders}`}>
                <div><i style={{ height: `${Math.max(item.bookings ? 8 : 0, item.bookings / chartMax * 100)}%` }}/><b style={{ height: `${Math.max(item.orders ? 8 : 0, item.orders / chartMax * 100)}%` }}/></div>
                <span>{index % 3 === 0 ? new Date(`${item.date}T12:00:00`).getDate() : ''}</span>
              </div>)}
            </div>
          </section>

          <section className="stats-card">
            <div className="stats-card-head"><h3>Топ услуг</h3><span>чаще всего</span></div>
            {overview.topServices.length === 0 ? <p className="stats-empty">Появится после первых согласованных смет.</p> : <ol className="stats-top">
              {overview.topServices.map((item, index) => <li key={item.name}>
                <i>{index + 1}</i><span>{item.name}</span><strong>{money.format(item.amountMinor / 100)} ₽</strong>
                <em><b className={index === 0 ? 'first' : ''} style={{ width: `${Math.max(3, item.count / topMax * 100)}%` }}/></em><small>{times(item.count)}</small>
              </li>)}
            </ol>}
          </section>

          <section className="stats-card">
            <div className="stats-card-head"><h3>Заказы по статусам</h3><span>{overview.orders.total}</span></div>
            <div className="stats-statuses">
              {overview.orderStatuses.length === 0 && <p className="stats-empty">За выбранный период заказов нет.</p>}
              {overview.orderStatuses.map((item) => <div key={item.status}>
                <span>{statusLabels[item.status]}</span><i><b style={{ width: `${item.count / statusMax * 100}%` }}/></i><strong>{item.count}</strong>
              </div>)}
            </div>
          </section>

          <section className="stats-card">
            <div className="stats-card-head"><h3>Выполнение операций</h3><span>{overview.operations.completionPercent}%</span></div>
            <div className="stats-progress"><b style={{ width: `${overview.operations.completionPercent}%` }}/></div>
            <p className="stats-empty">{overview.operations.done} из {overview.operations.total} выполнено · {overview.operations.blocked} заблокировано</p>
          </section>
        </div>
      </>}
    </section>
  );
}
