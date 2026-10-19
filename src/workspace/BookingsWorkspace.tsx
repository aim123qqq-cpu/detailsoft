import { useEffect, useMemo, useState } from 'react';
import { useSessionInfo } from '../session';
import { ApiRequestError, api } from '../api';
import { ServicesStep } from '../BookingFlow';
import type { Booking, BookingAvailability, BookingListItem, BookingQuote, BookingStatus, Lead, LeadStatus, OrderTarget, QuoteSelection } from '../types';
import { money, useWorkspaceItems, LoadingState, ErrorState, orderTarget } from './shared';

const bookingDate = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' });

const bookingTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

const bookingDateLong = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

const calendarHeading = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });

const calendarWeekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });

const bookingStatuses: Record<BookingStatus, { label: string; className: string }> = {
  DRAFT: { label: 'Черновик', className: 'active' },
  CONFIRMED: { label: 'Подтверждена', className: 'confirmed' },
  ARRIVED: { label: 'Клиент приехал', className: 'ready' },
  CANCELLED: { label: 'Отменена', className: 'cancelled' },
  NO_SHOW: { label: 'Не приехал', className: 'cancelled' }
};

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateFromKey(value: string) {
  return new Date(`${value}T12:00:00`);
}

function addCalendarDays(value: string, amount: number) {
  const date = dateFromKey(value);
  date.setDate(date.getDate() + amount);
  return localDateKey(date);
}

function visitWord(count: number) {
  const lastTwo = count % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'визитов';
  if (count % 10 === 1) return 'визит';
  if (count % 10 >= 2 && count % 10 <= 4) return 'визита';
  return 'визитов';
}

function calendarWeek(value: string) {
  const date = dateFromKey(value);
  const offset = (date.getDay() + 6) % 7;
  const monday = addCalendarDays(value, -offset);
  return Array.from({ length: 7 }, (_, index) => addCalendarDays(monday, index));
}

function useCalendarItems(enabled: boolean, from: string, to: string) {
  const [items, setItems] = useState<BookingListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setItems([]);
    api.listBookingCalendar(from, to, controller.signal)
      .then((result) => setItems(result.items))
      .catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled, from, to, revision]);
  return { items, loading, error, retry: () => setRevision((value) => value + 1) };
}

const noLeads = async () => ({ items: [] as Lead[] });

export function BookingsWorkspace({ onNew, onLeadConvert, onOpenCustomer, onOpenOrder, refreshToken }: {
  onNew: () => void;
  onLeadConvert: (lead: Lead) => void;
  onOpenCustomer: (customerId: string) => void;
  onOpenOrder: (target: OrderTarget) => void;
  refreshToken: number;
}) {
  const session = useSessionInfo();
  // Intake staff see the schedule to start intakes; leads and booking changes stay with the front desk.
  const canManage = !session || session.capabilities.manageBookings;
  const bookings = useWorkspaceItems(api.listBookings);
  const overdue = useWorkspaceItems(api.listOverdueBookings);
  const leads = useWorkspaceItems(canManage ? api.listLeads : noLeads);
  const [tab, setTab] = useState<'bookings' | 'leads'>('bookings');
  const [calendarMode, setCalendarMode] = useState<'day' | 'week' | 'list'>('list');
  const [calendarDate, setCalendarDate] = useState(localDateKey(new Date()));
  const [selected, setSelected] = useState<BookingListItem | null>(null);
  const weekDays = useMemo(() => calendarWeek(calendarDate), [calendarDate]);
  const calendarFrom = calendarMode === 'week' ? weekDays[0] : calendarDate;
  const calendarTo = calendarMode === 'week' ? weekDays[6] : calendarDate;
  const calendar = useCalendarItems(tab === 'bookings' && calendarMode !== 'list', calendarFrom, calendarTo);

  useEffect(() => {
    if (selected) window.scrollTo({ top: 0, behavior: 'auto' });
  }, [selected?.id]);

  // Returning from the order workspace: reload lists and pick up the opened booking's new state.
  useEffect(() => {
    if (!refreshToken) return;
    bookings.retry(); overdue.retry(); calendar.retry(); leads.retry();
  }, [refreshToken]);
  useEffect(() => {
    if (!selected) return;
    const updated = [...bookings.items, ...overdue.items].find((booking) => booking.id === selected.id);
    if (updated && (updated.status !== selected.status || updated.orderId !== selected.orderId)) setSelected(updated);
  }, [bookings.items, overdue.items]);

  if (selected) {
    return <BookingDetails item={selected} onBack={() => { setSelected(null); bookings.retry(); overdue.retry(); calendar.retry(); }} onChanged={setSelected} onOpenCustomer={onOpenCustomer} onOpenOrder={onOpenOrder} refreshToken={refreshToken} canManage={canManage}/>;
  }

  return (
    <section className="screen workspace-screen" data-testid="bookings-workspace">
      <div className="workspace-hero">
        <span>Расписание центра</span>
        <div><strong>{bookings.items.length}</strong><small>записей</small>{canManage && <><strong>{leads.items.filter((item) => item.status === 'NEW').length}</strong><small>новых</small></>}</div>
      </div>
      {canManage && <div className="workspace-section-tabs" role="tablist" aria-label="Записи и обращения">
        <button role="tab" aria-selected={tab === 'bookings'} className={tab === 'bookings' ? 'selected' : ''} onClick={() => setTab('bookings')}>Расписание <span>{bookings.items.length}</span></button>
        <button role="tab" aria-selected={tab === 'leads'} className={tab === 'leads' ? 'selected' : ''} onClick={() => setTab('leads')}>Обращения <span>{leads.items.filter((item) => item.status === 'NEW' || item.status === 'CONTACTED').length}</span></button>
      </div>}
      {tab === 'leads' ? <LeadsPanel data={leads} onConvert={onLeadConvert} onOpenCustomer={onOpenCustomer}/> : <>
      <div className="calendar-view-switch" role="tablist" aria-label="Режим календаря">
        <button role="tab" aria-selected={calendarMode === 'day'} className={calendarMode === 'day' ? 'selected' : ''} onClick={() => setCalendarMode('day')}>День</button>
        <button role="tab" aria-selected={calendarMode === 'week'} className={calendarMode === 'week' ? 'selected' : ''} onClick={() => setCalendarMode('week')}>Неделя</button>
        <button role="tab" aria-selected={calendarMode === 'list'} className={calendarMode === 'list' ? 'selected' : ''} onClick={() => setCalendarMode('list')}>Список</button>
      </div>
      {calendarMode === 'list' ? <>
        {overdue.items.length > 0 && <section className="overdue-bookings" data-testid="overdue-bookings">
          <div className="workspace-toolbar"><div><h2>Требуют отметки · {overdue.items.length}</h2><p>Время визита прошло: начните приёмку или отметьте неявку</p></div></div>
          <div className="workspace-list">{overdue.items.map((item) => <BookingCard key={item.id} item={item} onOpen={() => setSelected(item)}/>)}</div>
        </section>}
        <div className="workspace-toolbar"><div><h2>Ближайшие визиты</h2><p>С сегодняшнего дня, по времени</p></div>{canManage && <button onClick={onNew}>+ Новая</button>}</div>
        {bookings.loading ? <LoadingState/> : bookings.error ? <ErrorState message={bookings.error} onRetry={bookings.retry}/> : bookings.items.length === 0 ? (
          <div className="workspace-state"><strong>Записей пока нет</strong><span>{canManage ? 'Создайте первую запись для клиента' : 'Записи появятся, когда администратор их создаст'}</span>{canManage && <button onClick={onNew}>Создать запись</button>}</div>
        ) : <div className="workspace-list">{bookings.items.map((item) => <BookingCard key={item.id} item={item} onOpen={() => setSelected(item)}/>)}</div>}
      </> : <CalendarPanel mode={calendarMode} date={calendarDate} weekDays={weekDays} data={calendar} onDate={setCalendarDate} onNew={onNew} onOpen={setSelected}/>}</>}
    </section>
  );
}

function CalendarPanel({ mode, date, weekDays, data, onDate, onNew, onOpen }: {
  mode: 'day' | 'week';
  date: string;
  weekDays: string[];
  data: { items: BookingListItem[]; loading: boolean; error: string; retry: () => void };
  onDate: (date: string) => void;
  onNew: () => void;
  onOpen: (item: BookingListItem) => void;
}) {
  const activeItems = data.items.filter((item) => item.startAt.slice(0, 10) === date);
  const rangeTitle = mode === 'day'
    ? calendarHeading.format(dateFromKey(date))
    : `${calendarHeading.format(dateFromKey(weekDays[0]))} — ${calendarHeading.format(dateFromKey(weekDays[6]))}`;
  const shift = (amount: number) => onDate(addCalendarDays(date, mode === 'week' ? amount * 7 : amount));
  const activeMinutes = activeItems.filter((item) => item.status !== 'CANCELLED').reduce((sum, item) => sum + item.estimatedDurationMinutes, 0);

  return <div className="calendar-panel" data-testid="booking-calendar">
    <div className="calendar-toolbar">
      <button aria-label="Предыдущий период" onClick={() => shift(-1)}>‹</button>
      <label><span>{mode === 'day' ? 'Выбранный день' : 'Рабочая неделя'}</span><strong>{rangeTitle}</strong><input aria-label="Дата календаря" type="date" value={date} onChange={(event) => onDate(event.target.value)}/></label>
      <button aria-label="Следующий период" onClick={() => shift(1)}>›</button>
    </div>
    {mode === 'week' && <div className="calendar-week-strip" aria-label="Загрузка недели">{weekDays.map((day) => {
      const count = data.items.filter((item) => item.startAt.slice(0, 10) === day && item.status !== 'CANCELLED').length;
      const selected = day === date;
      return <button key={day} aria-label={`${calendarWeekday.format(dateFromKey(day))}, ${calendarHeading.format(dateFromKey(day))}: ${count} записей`} aria-pressed={selected} className={selected ? 'selected' : ''} onClick={() => onDate(day)}><span>{calendarWeekday.format(dateFromKey(day)).slice(0, 2)}</span><strong>{dateFromKey(day).getDate()}</strong><i style={{ height: `${Math.min(100, 16 + count * 24)}%` }}/><small>{count}</small></button>;
    })}</div>}
    <div className="calendar-day-summary"><div><span>{calendarWeekday.format(dateFromKey(date))}</span><strong>{calendarHeading.format(dateFromKey(date))}</strong></div><div><strong>{activeItems.filter((item) => item.status !== 'CANCELLED').length}</strong><span>{visitWord(activeItems.filter((item) => item.status !== 'CANCELLED').length)} · {Math.round(activeMinutes / 60 * 10) / 10} ч</span></div><button onClick={onNew}>+ Запись</button></div>
    {data.loading ? <LoadingState/> : data.error ? <ErrorState message={data.error} onRetry={data.retry}/> : activeItems.length === 0 ? <div className="calendar-empty"><strong>День свободен</strong><span>Записей на эту дату нет</span><button onClick={onNew}>Создать запись</button></div> : <div className="calendar-agenda">{activeItems.map((item) => <CalendarEvent key={item.id} item={item} onOpen={() => onOpen(item)}/>)}</div>}
  </div>;
}

function CalendarEvent({ item, onOpen }: { item: BookingListItem; onOpen: () => void }) {
  const start = new Date(item.startAt);
  const end = new Date(start.getTime() + item.estimatedDurationMinutes * 60_000);
  const status = bookingStatuses[item.status];
  return <button className={`calendar-event ${status.className}`} data-testid={`calendar-booking-${item.id}`} onClick={onOpen}>
    <span className="calendar-event-time"><strong>{bookingTime.format(start)}</strong><small>{bookingTime.format(end)}</small></span>
    <i/>
    <span className="calendar-event-body"><span><b>{item.customer.name}</b><em className="plate">{item.vehicle.plate}</em></span><small>{item.vehicle.make} {item.vehicle.model} · {item.estimatedDurationMinutes} мин</small><span className={`status-pill ${status.className}`}>{status.label}</span></span>
    <strong>›</strong>
  </button>;
}

const leadStatuses: Record<LeadStatus, { label: string; className: string }> = {
  NEW: { label: 'Новое', className: 'active' }, CONTACTED: { label: 'В работе', className: 'confirmed' },
  CONVERTED: { label: 'Запись создана', className: 'ready' }, LOST: { label: 'Потеряно', className: 'cancelled' }
};
const leadChannelLabels: Record<Lead['channel'], string> = {
  telegram: 'Telegram', vk: 'VK', instagram: 'Instagram', call: 'Звонок', in_person: 'На месте'
};

function LeadsPanel({ data, onConvert, onOpenCustomer }: {
  data: { items: Lead[]; loading: boolean; error: string; retry: () => void };
  onConvert: (lead: Lead) => void;
  onOpenCustomer: (customerId: string) => void;
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
        {lead.customer && <button className="lead-customer-link" data-testid={`lead-customer-${lead.id}`} onClick={() => onOpenCustomer(lead.customer!.id)}>Клиент найден: {lead.customer.name} · карточка ›</button>}
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
        <div className="workspace-card-top"><span className={`status-pill ${status.className}`}>{status.label}</span>{item.slotConflict ? <span className="booking-flag conflict">Конфликт времени</span> : item.pendingSync ? <span className="booking-flag pending">Не отправлено</span> : <span>{item.orderId ? 'Есть заказ' : leadChannelLabels[item.channel as Lead['channel']] ?? item.channel}</span>}</div>
        <h3>{item.customer.name}</h3>
        <p>{item.vehicle.make} {item.vehicle.model} {item.vehicle.generation}</p>
        <div className="workspace-card-meta"><span className="plate">{item.vehicle.plate}</span><span>{item.estimatedDurationMinutes} мин</span><strong>{money.format(item.preliminaryAmountMinor / 100)}</strong></div>
      </div>
    </button>
  );
}

function BookingDetails({ item, onBack, onChanged, onOpenCustomer, onOpenOrder, refreshToken, canManage }: {
  item: BookingListItem;
  onBack: () => void;
  onChanged: (item: BookingListItem) => void;
  onOpenCustomer: (customerId: string) => void;
  onOpenOrder: (target: OrderTarget) => void;
  refreshToken: number;
  canManage: boolean;
}) {
  const session = useSessionInfo();
  const canOpenCustomer = !session || session.capabilities.manageCustomers;
  const [mode, setMode] = useState<'details' | 'reschedule' | 'cancel' | 'noshow' | 'compose' | 'compose-review'>('details');
  const [date, setDate] = useState(item.startAt.slice(0, 10));
  const [availability, setAvailability] = useState<BookingAvailability | null>(null);
  const [selectedStartAt, setSelectedStartAt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [booking, setBooking] = useState<Booking | null>(null);
  const [bookingRevision, setBookingRevision] = useState(0);
  const [draft, setDraft] = useState<null | { selections: QuoteSelection[]; quote: BookingQuote }>(null);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const [slotConflict, setSlotConflict] = useState(false);
  // A new composition that does not fit its time is saved together with a new start.
  const [newStartAt, setNewStartAt] = useState('');
  const status = bookingStatuses[item.status];
  const locked = Boolean(item.orderId) || item.status !== 'CONFIRMED';

  useEffect(() => {
    const controller = new AbortController();
    api.getBooking(item.id, controller.signal)
      .then(setBooking)
      .catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); });
    return () => controller.abort();
  }, [item.id, bookingRevision, refreshToken]);

  const saveComposition = async () => {
    if (!booking || !draft) return;
    setLoading(true); setError(''); setSlotConflict(false);
    try {
      const updated = await api.reviseBookingQuote(item.id, {
        selections: draft.selections, expectedQuoteVersion: booking.quoteVersion, ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(newStartAt ? { startAt: newStartAt } : {})
      });
      setBooking(updated);
      onChanged({ ...item, startAt: updated.startAt, preliminaryAmountMinor: updated.preliminaryAmountMinor, estimatedDurationMinutes: updated.estimatedDurationMinutes, slotConflict: updated.slotConflict ?? false });
      setDraft(null); setReason(''); setNewStartAt(''); setMode('details');
      setNotice(`Состав обновлён: расчёт v${updated.quoteVersion}${newStartAt ? ', запись перенесена' : ''}. Предыдущая версия сохранена.`);
      window.scrollTo({ top: 0, behavior: 'auto' });
    } catch (requestError) {
      const code = requestError instanceof ApiRequestError ? requestError.code : '';
      if (code === 'slot_unavailable') setSlotConflict(true);
      if (code === 'stale_quote_version') setBookingRevision((value) => value + 1);
      setError((requestError as Error).message);
    } finally { setLoading(false); }
  };

  const composeScreen = mode === 'compose' && booking ? (
    <ServicesStep
      vehicle={{ ...item.vehicle, tenantClass: booking.quoteVersions.at(-1)?.vehicleClass ?? null }}
      initialSelections={draft?.selections ?? booking.lines.map((line) => ({ type: line.type, id: line.id }))}
      title="Изменить состав записи"
      backLabel="Отмена"
      continueLabel="Проверить изменения →"
      continueTestId="review-composition"
      onBack={() => { setDraft(null); setMode('details'); }}
      onContinue={(selections, quote) => { setDraft({ selections, quote }); setError(''); setSlotConflict(false); setNewStartAt(''); setMode('compose-review'); }}
    />
  ) : null;

  useEffect(() => {
    if (mode !== 'reschedule' || !date) return;
    const controller = new AbortController();
    setAvailability(null);
    setSelectedStartAt('');
    setError('');
    api.getBookingAvailability(date, item.estimatedDurationMinutes, controller.signal, item.id)
      .then(setAvailability)
      .catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); });
    return () => controller.abort();
  }, [date, item.estimatedDurationMinutes, mode]);

  const applyChange = async (input: { startAt: string } | { status: 'CANCELLED' | 'NO_SHOW' }) => {
    setLoading(true);
    setError('');
    try {
      const updated = await api.updateBooking(item.id, input);
      onChanged({ ...item, startAt: updated.startAt, status: updated.status, slotConflict: updated.slotConflict ?? false, pendingSync: updated.pendingSync });
      setMode('details');
      window.scrollTo({ top: 0, behavior: 'auto' });
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (composeScreen) return composeScreen;

  return (
    <section className="screen booking-details-screen" data-testid="booking-details">
      <button className="details-back" onClick={onBack}>← Все записи</button>
      <div className="booking-details-hero">
        <div><span className={`status-pill ${status.className}`}>{status.label}</span><small>#{item.id.replace('booking_', '').slice(0, 7)}</small></div>
        <h2>{item.customer.name}</h2>
        <p>{item.customer.phoneDisplay}</p>
        <div className="details-vehicle"><span className="plate">{item.vehicle.plate}</span><strong>{item.vehicle.make} {item.vehicle.model} {item.vehicle.generation}</strong><small>{item.vehicle.color}</small></div>
        {canOpenCustomer && <button className="details-customer-link" data-testid="booking-open-customer" onClick={() => onOpenCustomer(item.customer.id)}>Карточка клиента ›</button>}
      </div>
      {item.slotConflict && <div className="booking-conflict-banner" data-testid="booking-slot-conflict" role="alert"><strong>Конфликт времени</strong><span>Запись сделали без связи с сервером, а это время за это время заняли. Перенесите её на свободное время.</span></div>}
      {!item.slotConflict && item.pendingSync && <div className="booking-pending-banner" role="status">Сохранено на телефоне — отправится, когда появится связь</div>}
      <div className="details-grid">
        <div><span>Дата</span><strong>{bookingDateLong.format(new Date(item.startAt))}</strong></div>
        <div><span>Время</span><strong>{bookingTime.format(new Date(item.startAt))}</strong></div>
        <div><span>Длительность</span><strong>{item.estimatedDurationMinutes} мин</strong></div>
        <div><span>Предварительно</span><strong>{money.format(item.preliminaryAmountMinor / 100)}</strong></div>
      </div>

      {mode === 'details' && !locked && <div className="booking-arrival" data-testid="booking-arrival">
        <button className="primary-button" data-testid="start-booking-intake" onClick={() => onOpenOrder(orderTarget(item.id, null, item))}>Клиент приехал — начать приёмку</button>
        {canManage && Date.parse(item.startAt) <= Date.now() && <button className="secondary-action" data-testid="mark-no-show" onClick={() => setMode('noshow')}>Клиент не приехал</button>}
      </div>}
      {mode === 'details' && item.orderId && <button className="primary-button booking-open-order" data-testid="open-booking-order" onClick={() => onOpenOrder(orderTarget(item.id, item.orderId, item))}>Открыть рабочий заказ →</button>}
      {item.orderId && <div className="booking-lock-note"><strong>По записи уже создан заказ</strong><span>Дата, статус и состав зафиксированы; дальнейшие изменения идут через смету.</span></div>}
      {notice && mode === 'details' && <div className="vehicle-success" role="status">✓ {notice}</div>}
      {error && mode === 'details' && <p className="form-error" role="alert">{error}</p>}

      {mode === 'compose-review' && booking && draft && <CompositionReview
        booking={booking}
        draft={draft.quote}
        reason={reason}
        onReason={setReason}
        loading={loading}
        error={error}
        slotConflict={slotConflict}
        newStartAt={newStartAt}
        onPickStartAt={(value) => { setNewStartAt(value); setError(''); }}
        onEdit={() => setMode('compose')}
        onCancel={() => { setDraft(null); setError(''); setNewStartAt(''); setMode('details'); }}
        onSave={saveComposition}
      />}

      {mode === 'details' && booking && <section className="order-detail-section booking-composition" data-testid="booking-composition">
        <div className="detail-section-heading"><span>Состав записи</span><strong>Расчёт v{booking.quoteVersion}</strong></div>
        <div className="detail-rows">{booking.lines.map((line) => <div key={`${line.type}-${line.id}`}><span>{line.name}{line.amountMinor === 0 && line.excludedOperations.length > 0 ? ' · в пакете' : ''}</span><strong>{money.format(line.amountMinor / 100)}</strong></div>)}</div>
        {!locked && canManage && <button className="secondary-action composition-edit" data-testid="edit-composition" onClick={() => { setNotice(''); setError(''); setMode('compose'); }}>Изменить состав</button>}
        {booking.quoteVersions.length > 1 && <details className="composition-history" data-testid="composition-history">
          <summary>История расчёта · {booking.quoteVersions.length} {booking.quoteVersions.length < 5 ? 'версии' : 'версий'}</summary>
          <ol>{[...booking.quoteVersions].reverse().map((version) => <li key={version.version}>
            <div><b>v{version.version}{version.version === booking.quoteVersion ? ' · текущая' : ''}</b><strong>{money.format(version.totalAmountMinor / 100)} · {version.totalDurationMinutes} мин</strong></div>
            <span>{version.lines.map((line) => line.name).join(', ')}</span>
            <small>{bookingDateLong.format(new Date(version.createdAt))}{version.actorName ? ` · ${version.actorName}` : ''}{version.vehicleClass ? ` · класс ${version.vehicleClass}` : ''}</small>
            {version.reason && <em>{version.reason}</em>}
          </li>)}</ol>
        </details>}
      </section>}

      {mode === 'details' && !locked && canManage && <div className="booking-actions">
        <button className="secondary-action" onClick={() => setMode('reschedule')}>Перенести запись</button>
        <button className="danger-action" onClick={() => setMode('cancel')}>Отменить запись</button>
      </div>}

      {mode === 'noshow' && <div className="booking-edit-panel cancel-panel" data-testid="no-show-panel">
        <strong>Отметить, что клиент не приехал?</strong>
        <p>Запись получит статус «Не приехал» и освободит место в расписании. Отметка останется в истории клиента.</p>
        {error && <p className="form-error">{error}</p>}
        <div><button className="secondary-action" onClick={() => setMode('details')}>Оставить</button><button className="danger-action filled" data-testid="confirm-no-show" disabled={loading} onClick={() => applyChange({ status: 'NO_SHOW' })}>{loading ? 'Сохраняем…' : 'Да, не приехал'}</button></div>
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

function CompositionReview({ booking, draft, reason, onReason, loading, error, slotConflict, newStartAt, onPickStartAt, onEdit, onCancel, onSave }: {
  booking: Booking;
  draft: BookingQuote;
  reason: string;
  onReason: (value: string) => void;
  loading: boolean;
  error: string;
  slotConflict: boolean;
  newStartAt: string;
  onPickStartAt: (startAt: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const [date, setDate] = useState(booking.startAt.slice(0, 10));
  const [availability, setAvailability] = useState<BookingAvailability | null>(null);
  const picking = slotConflict || Boolean(newStartAt);
  useEffect(() => {
    if (!picking || !date) return;
    const controller = new AbortController();
    setAvailability(null);
    api.getBookingAvailability(date, draft.totalDurationMinutes, controller.signal, booking.id)
      .then(setAvailability).catch(() => {});
    return () => controller.abort();
  }, [picking, date, draft.totalDurationMinutes, booking.id]);
  const key = (line: { type: string; id: string }) => `${line.type}:${line.id}`;
  const currentKeys = new Set(booking.lines.map(key));
  const draftKeys = new Set(draft.lines.map(key));
  const added = draft.lines.filter((line) => !currentKeys.has(key(line)));
  const removed = booking.lines.filter((line) => !draftKeys.has(key(line)));
  const kept = draft.lines.filter((line) => currentKeys.has(key(line)));
  const amountDelta = draft.totalAmountMinor - booking.preliminaryAmountMinor;
  const durationDelta = draft.totalDurationMinutes - booking.estimatedDurationMinutes;
  const signed = (value: number, text: string) => `${value > 0 ? '+' : value < 0 ? '−' : '±'}${text}`;
  const unchanged = added.length === 0 && removed.length === 0;

  return <div className="booking-edit-panel composition-review" data-testid="composition-review">
    <div className="panel-heading"><div><strong>Новая версия расчёта v{booking.quoteVersion + 1}</strong><span>Сервер пересчитал цены по текущему каталогу</span></div><button onClick={onCancel} aria-label="Закрыть изменение состава">×</button></div>
    <div className="composition-diff">
      {added.map((line) => <div key={`add-${key(line)}`} className="added"><i>+</i><span>{line.name}</span><strong>{money.format(line.amountMinor / 100)}</strong></div>)}
      {removed.map((line) => <div key={`remove-${key(line)}`} className="removed"><i>−</i><span>{line.name}</span><strong>{money.format(line.amountMinor / 100)}</strong></div>)}
      {kept.map((line) => <div key={`keep-${key(line)}`}><i>·</i><span>{line.name}</span><strong>{money.format(line.amountMinor / 100)}</strong></div>)}
    </div>
    <div className="composition-totals">
      <div><span>Было · v{booking.quoteVersion}</span><strong>{money.format(booking.preliminaryAmountMinor / 100)}</strong><small>{booking.estimatedDurationMinutes} мин</small></div>
      <div className="next"><span>Станет</span><strong>{money.format(draft.totalAmountMinor / 100)}</strong><small>{draft.totalDurationMinutes} мин</small></div>
    </div>
    <p className="composition-delta" data-testid="composition-delta">{signed(amountDelta, money.format(Math.abs(amountDelta) / 100))} · {signed(durationDelta, `${Math.abs(durationDelta)} мин`)}. {newStartAt ? 'Запись перенесётся на выбранное время.' : 'Время начала не меняется: сервер проверит, что новая длительность помещается в слот.'}</p>
    {draft.warnings.map((warning) => <div className="quote-warning" key={`${warning.code}-${warning.itemId}`}>ⓘ {warning.message}</div>)}
    <label htmlFor="composition-reason">Причина изменения <small>необязательно</small></label>
    <input id="composition-reason" data-testid="composition-reason" value={reason} maxLength={200} onChange={(event) => onReason(event.target.value)} placeholder="Например, клиент добавил уход за салоном"/>
    {unchanged && <p className="form-error">Состав не изменился. Выберите другие услуги.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {picking && <div className="composition-new-time" data-testid="composition-new-time">
      <strong>Новое время для {draft.totalDurationMinutes} мин</strong>
      <label htmlFor="composition-date">Дата</label>
      <input id="composition-date" type="date" value={date} onChange={(event) => { setDate(event.target.value); onPickStartAt(''); }}/>
      <div className="reschedule-slots">
        {!availability ? <span className="slots-loading"><i className="spinner"/> Проверяем загрузку</span> : availability.slots.map((slot) => (
          <button key={slot.time} data-testid={`composition-slot-${slot.time}`} disabled={!slot.available} className={newStartAt === slot.startAt ? 'selected' : ''} onClick={() => onPickStartAt(slot.startAt)}>{slot.time}</button>
        ))}
        {availability?.closed && <span className="schedule-closed">В этот день центр не работает</span>}
      </div>
    </div>}
    <div className="composition-actions">
      <button className="secondary-action" onClick={onEdit}>Изменить выбор</button>
      <button className="primary-button" data-testid="save-composition" disabled={loading || unchanged || (slotConflict && !newStartAt)} onClick={onSave}>{loading ? 'Сохраняем…' : `Сохранить v${booking.quoteVersion + 1}${newStartAt ? ' и перенести' : ''}`}</button>
    </div>
  </div>;
}
