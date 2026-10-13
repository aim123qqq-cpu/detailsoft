import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { BookingListItem, OrderListItem, WorkOrder } from './types';

const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
const bookingDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' });
const bookingTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

function useWorkspaceItems<T>(load: (signal: AbortSignal) => Promise<{ items: T[] }>) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    load(controller.signal)
      .then((result) => setItems(result.items))
      .catch((requestError: Error) => {
        if (requestError.name !== 'AbortError') setError(requestError.message);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load, revision]);

  return { items, loading, error, retry: () => setRevision((value) => value + 1) };
}

function LoadingState() {
  return <div className="workspace-state"><span className="spinner"/> Загружаем данные центра</div>;
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="workspace-state error-state"><strong>Не удалось загрузить</strong><span>{message}</span><button onClick={onRetry}>Повторить</button></div>;
}

export function BookingsWorkspace({ onNew }: { onNew: () => void }) {
  const { items, loading, error, retry } = useWorkspaceItems(api.listBookings);
  const upcoming = useMemo(() => items.filter((item) => Date.parse(item.startAt) >= Date.now()).length, [items]);

  return (
    <section className="screen workspace-screen" data-testid="bookings-workspace">
      <div className="workspace-hero">
        <span>Расписание центра</span>
        <div><strong>{items.length}</strong><small>записей</small><strong>{upcoming}</strong><small>впереди</small></div>
      </div>
      <div className="workspace-toolbar"><div><h2>Ближайшие визиты</h2><p>Клиент, автомобиль и состав записи</p></div><button onClick={onNew}>+ Новая</button></div>
      {loading ? <LoadingState/> : error ? <ErrorState message={error} onRetry={retry}/> : items.length === 0 ? (
        <div className="workspace-state"><strong>Записей пока нет</strong><span>Создайте первую запись для клиента</span><button onClick={onNew}>Создать запись</button></div>
      ) : <div className="workspace-list">{items.map((item) => <BookingCard key={item.id} item={item}/>)}</div>}
    </section>
  );
}

function BookingCard({ item }: { item: BookingListItem }) {
  const date = new Date(item.startAt);
  return (
    <article className="workspace-card booking-card">
      <div className="workspace-card-time"><strong>{bookingTime.format(date)}</strong><span>{bookingDate.format(date)}</span></div>
      <div className="workspace-card-body">
        <div className="workspace-card-top"><span className="status-pill confirmed">Подтверждена</span><span>{item.channel}</span></div>
        <h3>{item.customer.name}</h3>
        <p>{item.vehicle.make} {item.vehicle.model} {item.vehicle.generation}</p>
        <div className="workspace-card-meta"><span className="plate">{item.vehicle.plate}</span><span>{item.estimatedDurationMinutes} мин</span><strong>{money.format(item.preliminaryAmountMinor / 100)}</strong></div>
      </div>
    </article>
  );
}

const orderStatuses: Record<WorkOrder['status'], { label: string; group: 'active' | 'ready' | 'closed' }> = {
  INTAKE: { label: 'Приёмка', group: 'active' },
  ESTIMATE_DRAFT: { label: 'Смета', group: 'active' },
  APPROVED: { label: 'Согласован', group: 'active' },
  IN_PROGRESS: { label: 'В работе', group: 'active' },
  QC: { label: 'Контроль качества', group: 'active' },
  READY: { label: 'Готов к выдаче', group: 'ready' },
  CLOSED: { label: 'Закрыт', group: 'closed' }
};

type OrderFilter = 'all' | 'active' | 'ready' | 'closed';

export function OrdersWorkspace() {
  const { items, loading, error, retry } = useWorkspaceItems(api.listOrders);
  const [filter, setFilter] = useState<OrderFilter>('all');
  const filtered = filter === 'all' ? items : items.filter((item) => orderStatuses[item.status].group === filter);
  const filters: Array<{ id: OrderFilter; label: string }> = [
    { id: 'all', label: 'Все' }, { id: 'active', label: 'В работе' }, { id: 'ready', label: 'К выдаче' }, { id: 'closed', label: 'Закрытые' }
  ];

  return (
    <section className="screen workspace-screen" data-testid="orders-workspace">
      <div className="workspace-hero orders-hero"><span>Рабочая очередь</span><div><strong>{items.filter((item) => orderStatuses[item.status].group === 'active').length}</strong><small>в работе</small><strong>{items.filter((item) => item.status === 'READY').length}</strong><small>к выдаче</small></div></div>
      <div className="workspace-toolbar"><div><h2>Заказы</h2><p>Текущий этап и ответственный</p></div></div>
      <div className="workspace-filters" aria-label="Фильтр заказов">{filters.map((item) => <button key={item.id} className={filter === item.id ? 'selected' : ''} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
      {loading ? <LoadingState/> : error ? <ErrorState message={error} onRetry={retry}/> : filtered.length === 0 ? (
        <div className="workspace-state"><strong>В этой группе пусто</strong><span>Заказы появятся после начала приёмки</span></div>
      ) : <div className="workspace-list orders-list">{filtered.map((item) => <OrderCard key={item.id} item={item}/>)}</div>}
    </section>
  );
}

function OrderCard({ item }: { item: OrderListItem }) {
  const status = orderStatuses[item.status];
  return (
    <article className="workspace-card order-card">
      <div className="workspace-card-body">
        <div className="workspace-card-top"><span className={`status-pill ${status.group}`}>{status.label}</span><span>#{item.id.replace('order_', '').slice(0, 6)}</span></div>
        <h3>{item.customer.name}</h3>
        <p>{item.vehicle.make} {item.vehicle.model} {item.vehicle.generation}</p>
        <div className="workspace-card-meta"><span className="plate">{item.vehicle.plate}</span><span>{item.masterName ?? 'Мастер не назначен'}</span></div>
        <div className="order-summary"><span>Смета</span><strong>{item.totalAmountMinor === null ? 'Не составлена' : money.format(item.totalAmountMinor / 100)}</strong></div>
      </div>
    </article>
  );
}
