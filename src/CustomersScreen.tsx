import { useEffect, useState } from 'react';
import { api } from './api';
import type { CustomerListItem, WorkOrder } from './types';
import { LoadingState, ErrorState } from './workspace/shared';

type Filter = 'all' | 'booked' | 'active' | 'archive';

const filters: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'Все' }, { id: 'booked', label: 'С записью' }, { id: 'active', label: 'В работе' }, { id: 'archive', label: 'Архив' }
];

const orderLabels: Record<WorkOrder['status'], string> = {
  INTAKE: 'Приёмка', ESTIMATE_DRAFT: 'Смета у клиента', APPROVED: 'Согласован', IN_PROGRESS: 'В работе', QC: 'Контроль качества', READY: 'К выдаче', CLOSED: 'Закрыт'
};

const shortDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const monthYear = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' });
const bookingMoment = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

function lastVisit(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return 'сегодня';
  return now.getTime() - date.getTime() > 300 * 24 * 60 * 60_000 ? monthYear.format(date) : shortDate.format(date);
}

/** What is going on with the customer right now: an open order, else the next booking. */
function nowState(item: CustomerListItem): { label: string; tone: 'work' | 'wait' | 'quiet' } | null {
  if (item.archived) return { label: 'В архиве', tone: 'quiet' };
  if (item.openOrderStatus) return { label: orderLabels[item.openOrderStatus], tone: item.openOrderStatus === 'ESTIMATE_DRAFT' ? 'wait' : 'work' };
  if (item.nextBookingAt) return { label: `Запись ${bookingMoment.format(new Date(item.nextBookingAt)).replace(',', '')}`, tone: 'wait' };
  return null;
}

/** The customers section: everyone in the center, found by name, phone or plate. */
export function CustomersScreen({ onOpenCustomer, onTotal, refreshToken }: {
  onOpenCustomer: (customerId: string) => void;
  /** Reports how many customers the center has, for the header. */
  onTotal?: (total: number) => void;
  refreshToken: number;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<CustomerListItem[] | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    // Typing does not send a request per letter.
    const timer = window.setTimeout(() => {
      api.listCustomers(query.trim(), filter, controller.signal)
        .then((result) => { setItems(result.items); onTotal?.(result.total); })
        .catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); });
    }, query ? 280 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, filter, revision, refreshToken]);

  return (
    <section className="screen customers-screen" data-testid="customers-screen">
      <div className="customers-bar">
        <div className="workspace-filters" aria-label="Фильтр клиентов">{filters.map((item) => <button key={item.id} className={filter === item.id ? 'selected' : ''} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
        <label className="customers-search">
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
          <input data-testid="customers-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Телефон, госномер или имя" aria-label="Поиск клиента"/>
        </label>
      </div>
      {error ? <ErrorState message={error} onRetry={() => setRevision((value) => value + 1)}/> : items === null ? <LoadingState/> : items.length === 0 ? (
        <div className="workspace-state"><strong>{query ? 'Никого не нашли' : 'Здесь пока пусто'}</strong><span>{query ? 'Проверьте номер, имя или госномер' : filter === 'all' ? 'Клиенты появятся с первой записью' : 'В этой группе клиентов нет'}</span></div>
      ) : <div className="customers-table" role="table" aria-label="Клиенты">
        <div className="customers-head" role="row"><span role="columnheader">Клиент</span><span role="columnheader">Телефон</span><span role="columnheader">Автомобили</span><span role="columnheader">Последний визит</span><span role="columnheader">Визитов</span><span role="columnheader">Сейчас</span></div>
        {items.map((item) => {
          const state = nowState(item);
          return <button key={item.id} role="row" className={`customers-row ${item.archived ? 'archived' : ''}`} data-testid={`customer-row-${item.id}`} onClick={() => onOpenCustomer(item.id)}>
            <strong role="cell">{item.name}</strong>
            <span role="cell" className="customers-phone">{item.phoneDisplay}</span>
            <span role="cell">{item.vehicles.length ? item.vehicles.map((vehicle) => `${vehicle.make} ${vehicle.model}`).join(' · ') : '—'}</span>
            <span role="cell" data-label="Последний визит">{lastVisit(item.lastVisitAt)}</span>
            <span role="cell" data-label="Визитов">{item.visitCount}</span>
            <span role="cell">{state && <em className={`customers-now ${state.tone}`}>{state.label}</em>}</span>
          </button>;
        })}
      </div>}
    </section>
  );
}
