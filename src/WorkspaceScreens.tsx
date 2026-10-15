import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { productFeatures } from './features';
import type { BookingAvailability, BookingListItem, BookingStatus, Lead, LeadStatus, OrderListItem, WorkOrder } from './types';

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

export function BookingsWorkspace({ onNew, onLeadConvert }: { onNew: () => void; onLeadConvert: (lead: Lead) => void }) {
  const bookings = useWorkspaceItems(api.listBookings);
  const leads = useWorkspaceItems(api.listLeads);
  const [tab, setTab] = useState<'bookings' | 'leads'>('bookings');
  const [selected, setSelected] = useState<BookingListItem | null>(null);

  useEffect(() => {
    if (selected) window.scrollTo({ top: 0, behavior: 'auto' });
  }, [selected?.id]);

  if (selected) {
    return <BookingDetails item={selected} onBack={() => { setSelected(null); bookings.retry(); }} onChanged={setSelected}/>;
  }

  return (
    <section className="screen workspace-screen" data-testid="bookings-workspace">
      <div className="workspace-hero">
        <span>Расписание центра</span>
        <div><strong>{bookings.items.length}</strong><small>записей</small><strong>{leads.items.filter((item) => item.status === 'NEW').length}</strong><small>новых</small></div>
      </div>
      <div className="workspace-section-tabs" role="tablist" aria-label="Записи и обращения">
        <button role="tab" aria-selected={tab === 'bookings'} className={tab === 'bookings' ? 'selected' : ''} onClick={() => setTab('bookings')}>Расписание <span>{bookings.items.length}</span></button>
        <button role="tab" aria-selected={tab === 'leads'} className={tab === 'leads' ? 'selected' : ''} onClick={() => setTab('leads')}>Обращения <span>{leads.items.filter((item) => item.status === 'NEW' || item.status === 'CONTACTED').length}</span></button>
      </div>
      {tab === 'leads' ? <LeadsPanel data={leads} onConvert={onLeadConvert}/> : <>
      <div className="workspace-toolbar"><div><h2>Ближайшие визиты</h2><p>Клиент, автомобиль и состав записи</p></div><button onClick={onNew}>+ Новая</button></div>
      {bookings.loading ? <LoadingState/> : bookings.error ? <ErrorState message={bookings.error} onRetry={bookings.retry}/> : bookings.items.length === 0 ? (
        <div className="workspace-state"><strong>Записей пока нет</strong><span>Создайте первую запись для клиента</span><button onClick={onNew}>Создать запись</button></div>
      ) : <div className="workspace-list">{bookings.items.map((item) => <BookingCard key={item.id} item={item} onOpen={() => setSelected(item)}/>)}</div>}</>}
    </section>
  );
}

const leadStatuses: Record<LeadStatus, { label: string; className: string }> = {
  NEW: { label: 'Новое', className: 'active' }, CONTACTED: { label: 'В работе', className: 'confirmed' },
  CONVERTED: { label: 'Запись создана', className: 'ready' }, LOST: { label: 'Потеряно', className: 'cancelled' }
};
const leadChannelLabels: Record<Lead['channel'], string> = {
  telegram: 'Telegram', vk: 'VK', instagram: 'Instagram', call: 'Звонок', in_person: 'На месте'
};

function LeadsPanel({ data, onConvert }: {
  data: { items: Lead[]; loading: boolean; error: string; retry: () => void };
  onConvert: (lead: Lead) => void;
}) {
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const [creating, setCreating] = useState(false);
  const [channel, setChannel] = useState<Lead['channel']>('telegram');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const visible = filter === 'all' ? data.items : data.items.filter((lead) => lead.status === 'NEW' || lead.status === 'CONTACTED');

  const create = async () => {
    setSaving(true); setError('');
    try {
      await api.createLead({ channel, contactName, phone, note });
      setCreating(false); setContactName(''); setPhone(''); setNote(''); data.retry();
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setSaving(false); }
  };
  const changeStatus = async (lead: Lead, status: 'CONTACTED' | 'LOST') => {
    setSaving(true); setError('');
    try { await api.updateLeadStatus(lead.id, status); data.retry(); }
    catch (requestError) { setError((requestError as Error).message); }
    finally { setSaving(false); }
  };

  return <div className="leads-panel" data-testid="leads-panel">
    <div className="workspace-toolbar"><div><h2>Входящие обращения</h2><p>Новые запросы до выбора услуг и времени</p></div><button onClick={() => setCreating((value) => !value)}>+ Обращение</button></div>
    <div className="workspace-filters"><button className={filter === 'active' ? 'selected' : ''} onClick={() => setFilter('active')}>Активные</button><button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>Все</button></div>
    {creating && <div className="lead-create-form" data-testid="lead-create-form">
      <div className="lead-channel-grid">{(Object.keys(leadChannelLabels) as Lead['channel'][]).map((value) => <button key={value} className={channel === value ? 'selected' : ''} onClick={() => setChannel(value)}>{leadChannelLabels[value]}</button>)}</div>
      <label>Имя<input value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder="Как обращаться"/></label>
      <label>Телефон<input data-testid="lead-phone" value={phone} inputMode="tel" onChange={(event) => setPhone(event.target.value)} placeholder="+7 999 000-00-00"/></label>
      <label>Что нужно<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Услуга, пожелания, когда перезвонить"/></label>
      {error && <p className="form-error">{error}</p>}
      <button className="primary-button" data-testid="save-lead" disabled={saving || contactName.trim().length < 2 || phone.replace(/\D/g, '').length < 7} onClick={create}>{saving ? 'Сохраняем…' : 'Сохранить обращение'}</button>
    </div>}
    {data.loading ? <LoadingState/> : data.error ? <ErrorState message={data.error} onRetry={data.retry}/> : visible.length === 0 ? <div className="workspace-state"><strong>Активных обращений нет</strong><span>Новые запросы появятся здесь</span></div> : <div className="lead-list">{visible.map((lead) => {
      const status = leadStatuses[lead.status];
      return <article className="lead-card" key={lead.id} data-testid={`lead-card-${lead.id}`}>
        <div className="lead-card-top"><span className={`status-pill ${status.className}`}>{status.label}</span><span>{leadChannelLabels[lead.channel]}</span></div>
        <h3>{lead.contactName}</h3><a href={`tel:${lead.phoneDisplay}`}>{lead.phoneDisplay}</a><p>{lead.note || 'Комментарий не добавлен'}</p>
        {lead.customer && <small>Клиент найден: {lead.customer.name}</small>}
        {(lead.status === 'NEW' || lead.status === 'CONTACTED') && <div className="lead-actions">
          {lead.status === 'NEW' && <button disabled={saving} onClick={() => changeStatus(lead, 'CONTACTED')}>В работу</button>}
          <button className="primary" disabled={saving} onClick={() => onConvert(lead)}>В запись →</button>
          <button className="danger" disabled={saving} onClick={() => changeStatus(lead, 'LOST')}>Потеряно</button>
        </div>}
        {lead.bookingId && <div className="lead-linked">✓ Связано с записью #{lead.bookingId.replace('booking_', '').slice(0, 7)}</div>}
      </article>;
    })}</div>}
  </div>;
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
          {availability?.closed && <span className="schedule-closed">В этот день центр не работает</span>}
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
  const [selected, setSelected] = useState<OrderListItem | null>(null);
  const filtered = filter === 'all' ? items : items.filter((item) => orderStatuses[item.status].group === filter);
  const filters: Array<{ id: OrderFilter; label: string }> = [
    { id: 'all', label: 'Все' }, { id: 'active', label: 'В работе' }, { id: 'ready', label: 'К выдаче' }, { id: 'closed', label: 'Закрытые' }
  ];

  useEffect(() => {
    if (selected) window.scrollTo({ top: 0, behavior: 'auto' });
  }, [selected?.id]);

  if (selected) return <OrderDetails item={selected} onBack={() => { setSelected(null); retry(); }}/>;

  return (
    <section className="screen workspace-screen" data-testid="orders-workspace">
      <div className="workspace-hero orders-hero"><span>Рабочая очередь</span><div><strong>{items.filter((item) => orderStatuses[item.status].group === 'active').length}</strong><small>в работе</small><strong>{items.filter((item) => item.status === 'READY').length}</strong><small>к выдаче</small></div></div>
      <div className="workspace-toolbar"><div><h2>Заказы</h2><p>Текущий этап и ответственный</p></div></div>
      <div className="workspace-filters" aria-label="Фильтр заказов">{filters.map((item) => <button key={item.id} className={filter === item.id ? 'selected' : ''} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
      {loading ? <LoadingState/> : error ? <ErrorState message={error} onRetry={retry}/> : filtered.length === 0 ? (
        <div className="workspace-state"><strong>В этой группе пусто</strong><span>Заказы появятся после начала приёмки</span></div>
      ) : <div className="workspace-list orders-list">{filtered.map((item) => <OrderCard key={item.id} item={item} onOpen={() => setSelected(item)}/>)}</div>}
    </section>
  );
}

function OrderCard({ item, onOpen }: { item: OrderListItem; onOpen: () => void }) {
  const status = orderStatuses[item.status];
  return (
    <button className="workspace-card order-card" data-testid={`order-card-${item.id}`} onClick={onOpen}>
      <div className="workspace-card-body">
        <div className="workspace-card-top"><span className={`status-pill ${status.group}`}>{status.label}</span><span>#{item.id.replace('order_', '').slice(0, 6)}</span></div>
        <h3>{item.customer.name}</h3>
        <p>{item.vehicle.make} {item.vehicle.model} {item.vehicle.generation}</p>
        <div className="workspace-card-meta"><span className="plate">{item.vehicle.plate}</span><span>{item.masterName ?? 'Мастер не назначен'}</span></div>
        <div className="order-summary"><span>Смета</span><strong>{item.totalAmountMinor === null ? 'Не составлена' : money.format(item.totalAmountMinor / 100)}</strong></div>
      </div>
    </button>
  );
}

const orderStages = productFeatures.qualityControl
  ? ['Приёмка', 'Смета', 'Работы', 'QC', 'Выдача']
  : ['Приёмка', 'Смета', 'Работы', 'Выдача'];

function orderStageIndex(status: WorkOrder['status']) {
  if (status === 'INTAKE') return 0;
  if (status === 'ESTIMATE_DRAFT' || status === 'APPROVED') return 1;
  if (status === 'IN_PROGRESS') return 2;
  if (status === 'QC') return productFeatures.qualityControl ? 3 : 2;
  if (status === 'READY') return productFeatures.qualityControl ? 4 : 3;
  return orderStages.length;
}

function OrderDetails({ item, onBack }: { item: OrderListItem; onBack: () => void }) {
  const [order, setOrder] = useState<WorkOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api.getOrder(item.id, controller.signal)
      .then(setOrder)
      .catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [item.id, revision]);

  const status = orderStatuses[order?.status ?? item.status];
  const currentEstimate = order?.estimateVersions.find((estimate) => estimate.id === order.currentEstimateVersionId) ?? null;
  const doneOperations = order?.work?.operations.filter((operation) => operation.status === 'DONE').length ?? 0;
  const totalOperations = order?.work?.operations.length ?? 0;
  const lastQc = order?.qualityControl.at(-1) ?? null;

  return (
    <section className="screen order-details-screen" data-testid="order-details">
      <button className="details-back" onClick={onBack}>← Все заказы</button>
      {loading && !order ? <LoadingState/> : error && !order ? <ErrorState message={error} onRetry={() => setRevision((value) => value + 1)}/> : order && <>
        <div className="order-details-hero">
          <div><span className={`status-pill ${status.group}`}>{status.label}</span><small>#{item.id.replace('order_', '').slice(0, 8)}</small></div>
          <h2>{order.status === 'CLOSED' ? 'Заказ закрыт' : status.label}</h2>
          <p>{item.customer.name} · {item.customer.phoneDisplay}</p>
          <div className="details-vehicle"><span className="plate">{item.vehicle.plate}</span><strong>{item.vehicle.make} {item.vehicle.model} {item.vehicle.generation}</strong><small>{item.vehicle.color}</small></div>
        </div>

        <div className="order-timeline" aria-label="Этапы заказа" style={{ gridTemplateColumns: `repeat(${orderStages.length}, 1fr)` }}>
          {orderStages.map((stage, index) => <div key={stage} className={index < orderStageIndex(order.status) ? 'done' : index === orderStageIndex(order.status) ? 'current' : ''}><i>{index < orderStageIndex(order.status) || order.status === 'CLOSED' ? '✓' : index + 1}</i><span>{stage}</span></div>)}
        </div>

        <div className="details-grid order-details-grid">
          <div><span>Смета</span><strong>{currentEstimate ? money.format(currentEstimate.totalAmountMinor / 100) : 'Не составлена'}</strong></div>
          <div><span>Мастер</span><strong>{order.assignment?.masterName ?? 'Не назначен'}</strong></div>
          <div><span>Операции</span><strong>{totalOperations ? `${doneOperations} из ${totalOperations}` : 'Нет операций'}</strong></div>
          <div><span>События</span><strong>{order.auditTrail.length} в журнале</strong></div>
        </div>

        {currentEstimate && <section className="order-detail-section">
          <div className="detail-section-heading"><span>Смета v{currentEstimate.version}</span><strong>{currentEstimate.lines.length} позиции</strong></div>
          <div className="detail-rows">{currentEstimate.lines.map((line) => <div key={line.id}><span>{line.name}</span><strong>{money.format(line.amountMinor / 100)}</strong></div>)}</div>
        </section>}

        {order.work && <section className="order-detail-section">
          <div className="detail-section-heading"><span>Работы</span><strong>{doneOperations}/{totalOperations}</strong></div>
          <div className="detail-rows operation-history">{order.work.operations.map((operation) => <div key={operation.id}><i className={operation.status.toLowerCase()}>{operation.status === 'DONE' ? '✓' : '·'}</i><span>{operation.name}</span><strong>{operation.status === 'DONE' ? 'Готово' : operation.status === 'BLOCKED' ? 'Проблема' : 'Ожидает'}</strong></div>)}</div>
        </section>}

        {lastQc && <section className="order-detail-section qc-history">
          <div className="detail-section-heading"><span>Контроль качества</span><strong>{lastQc.decision === 'PASSED' ? 'Пройден' : 'Доработка'}</strong></div>
          <p>{lastQc.responsible} · {lastQc.note}</p>
        </section>}

        {order.handover && <div className="handover-proof"><strong>Автомобиль выдан</strong><br/>✓ {order.handover.responsible} · {order.handover.note}</div>}
      </>}
    </section>
  );
}
