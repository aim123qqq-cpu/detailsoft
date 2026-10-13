import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { BookingAvailability, BookingListItem, BookingStatus, OrderListItem, WorkOrder } from './types';

const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
const bookingDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' });
const bookingTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const bookingDateLong = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const bookingStatuses: Record<BookingStatus, { label: string; className: string }> = {
  DRAFT: { label: 'Черновик', className: 'active' },
  CONFIRMED: { label: 'Подтверждена', className: 'confirmed' },
  ARRIVED: { label: 'Клиент приехал', className: 'ready' },
  CANCELLED: { label: 'Отменена', className: 'cancelled' },
  NO_SHOW: { label: 'Не приехал', className: 'cancelled' }
};

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
  const [selected, setSelected] = useState<BookingListItem | null>(null);
  const upcoming = useMemo(() => items.filter((item) => item.status === 'CONFIRMED' && Date.parse(item.startAt) >= Date.now()).length, [items]);

  useEffect(() => {
    if (selected) window.scrollTo({ top: 0, behavior: 'auto' });
  }, [selected?.id]);

  if (selected) {
    return <BookingDetails item={selected} onBack={() => { setSelected(null); retry(); }} onChanged={setSelected}/>;
  }

  return (
    <section className="screen workspace-screen" data-testid="bookings-workspace">
      <div className="workspace-hero">
        <span>Расписание центра</span>
        <div><strong>{items.length}</strong><small>записей</small><strong>{upcoming}</strong><small>впереди</small></div>
      </div>
      <div className="workspace-toolbar"><div><h2>Ближайшие визиты</h2><p>Клиент, автомобиль и состав записи</p></div><button onClick={onNew}>+ Новая</button></div>
      {loading ? <LoadingState/> : error ? <ErrorState message={error} onRetry={retry}/> : items.length === 0 ? (
        <div className="workspace-state"><strong>Записей пока нет</strong><span>Создайте первую запись для клиента</span><button onClick={onNew}>Создать запись</button></div>
      ) : <div className="workspace-list">{items.map((item) => <BookingCard key={item.id} item={item} onOpen={() => setSelected(item)}/>)}</div>}
    </section>
  );
}

function BookingCard({ item, onOpen }: { item: BookingListItem; onOpen: () => void }) {
  const date = new Date(item.startAt);
  const status = bookingStatuses[item.status];
  return (
    <button className="workspace-card booking-card" data-testid={`booking-card-${item.id}`} onClick={onOpen}>
      <div className="workspace-card-time"><strong>{bookingTime.format(date)}</strong><span>{bookingDate.format(date)}</span></div>
      <div className="workspace-card-body">
        <div className="workspace-card-top"><span className={`status-pill ${status.className}`}>{status.label}</span><span>{item.orderId ? 'Есть заказ' : item.channel}</span></div>
        <h3>{item.customer.name}</h3>
        <p>{item.vehicle.make} {item.vehicle.model} {item.vehicle.generation}</p>
        <div className="workspace-card-meta"><span className="plate">{item.vehicle.plate}</span><span>{item.estimatedDurationMinutes} мин</span><strong>{money.format(item.preliminaryAmountMinor / 100)}</strong></div>
      </div>
    </button>
  );
}

function BookingDetails({ item, onBack, onChanged }: {
  item: BookingListItem;
  onBack: () => void;
  onChanged: (item: BookingListItem) => void;
}) {
  const [mode, setMode] = useState<'details' | 'reschedule' | 'cancel'>('details');
  const [date, setDate] = useState(item.startAt.slice(0, 10));
  const [availability, setAvailability] = useState<BookingAvailability | null>(null);
  const [selectedStartAt, setSelectedStartAt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const status = bookingStatuses[item.status];
  const locked = Boolean(item.orderId) || item.status !== 'CONFIRMED';

  useEffect(() => {
    if (mode !== 'reschedule' || !date) return;
    const controller = new AbortController();
    setAvailability(null);
    setSelectedStartAt('');
    setError('');
    api.getBookingAvailability(date, item.estimatedDurationMinutes, controller.signal)
      .then(setAvailability)
      .catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); });
    return () => controller.abort();
  }, [date, item.estimatedDurationMinutes, mode]);

  const applyChange = async (input: { startAt: string } | { status: 'CANCELLED' }) => {
    setLoading(true);
    setError('');
    try {
      const updated = await api.updateBooking(item.id, input);
      onChanged({ ...item, startAt: updated.startAt, status: updated.status });
      setMode('details');
      window.scrollTo({ top: 0, behavior: 'auto' });
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="screen booking-details-screen" data-testid="booking-details">
      <button className="details-back" onClick={onBack}>← Все записи</button>
      <div className="booking-details-hero">
        <div><span className={`status-pill ${status.className}`}>{status.label}</span><small>#{item.id.replace('booking_', '').slice(0, 7)}</small></div>
        <h2>{item.customer.name}</h2>
        <p>{item.customer.phoneDisplay}</p>
        <div className="details-vehicle"><span className="plate">{item.vehicle.plate}</span><strong>{item.vehicle.make} {item.vehicle.model} {item.vehicle.generation}</strong><small>{item.vehicle.color}</small></div>
      </div>
      <div className="details-grid">
        <div><span>Дата</span><strong>{bookingDateLong.format(new Date(item.startAt))}</strong></div>
        <div><span>Время</span><strong>{bookingTime.format(new Date(item.startAt))}</strong></div>
        <div><span>Длительность</span><strong>{item.estimatedDurationMinutes} мин</strong></div>
        <div><span>Предварительно</span><strong>{money.format(item.preliminaryAmountMinor / 100)}</strong></div>
      </div>

      {item.orderId && <div className="booking-lock-note"><strong>По записи уже создан заказ</strong><span>Дата и статус зафиксированы в истории работ.</span></div>}

      {mode === 'details' && !locked && <div className="booking-actions">
        <button className="secondary-action" onClick={() => setMode('reschedule')}>Перенести запись</button>
        <button className="danger-action" onClick={() => setMode('cancel')}>Отменить запись</button>
      </div>}

      {mode === 'reschedule' && <div className="booking-edit-panel">
        <div className="panel-heading"><div><strong>Новое время</strong><span>Выберите дату и свободный слот</span></div><button onClick={() => setMode('details')} aria-label="Закрыть перенос">×</button></div>
        <label htmlFor="reschedule-date">Новая дата</label>
        <input id="reschedule-date" type="date" value={date} onChange={(event) => setDate(event.target.value)}/>
        <div className="reschedule-slots">
          {!availability ? <span className="slots-loading"><i className="spinner"/> Проверяем загрузку</span> : availability.slots.map((slot) => (
            <button key={slot.time} disabled={!slot.available} className={selectedStartAt === slot.startAt ? 'selected' : ''} onClick={() => setSelectedStartAt(slot.startAt)}>{slot.time}</button>
          ))}
        </div>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button reschedule-submit" disabled={!selectedStartAt || loading} onClick={() => applyChange({ startAt: selectedStartAt })}>{loading ? 'Переносим…' : 'Подтвердить перенос'}</button>
      </div>}

      {mode === 'cancel' && <div className="booking-edit-panel cancel-panel">
        <strong>Отменить запись?</strong>
        <p>Она останется в истории центра со статусом «Отменена».</p>
        {error && <p className="form-error">{error}</p>}
        <div><button className="secondary-action" onClick={() => setMode('details')}>Оставить</button><button className="danger-action filled" disabled={loading} onClick={() => applyChange({ status: 'CANCELLED' })}>{loading ? 'Отменяем…' : 'Да, отменить'}</button></div>
      </div>}
    </section>
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
