import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { randomId } from './platform';
import type { Booking, BookingAvailability, BookingQuote, Customer, QuoteSelection, ServiceCatalog, ServiceOffering, Vehicle } from './types';

const channelCodes: Record<string, string> = {
  Telegram: 'telegram',
  VK: 'vk',
  Instagram: 'instagram',
  'Звонок': 'call',
  'На месте': 'in_person'
};

function formatMoney(amountMinor: number) {
  return `${Math.round(amountMinor / 100).toLocaleString('ru-RU')} ₽`;
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

function localDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export type ServiceVehicle = Pick<Vehicle, 'id' | 'make' | 'model' | 'generation' | 'plate' | 'color'> & { tenantClass?: string | null };

function VehicleSummary({ vehicle, onChange, changeLabel = 'Изменить' }: { vehicle: ServiceVehicle; onChange: () => void; changeLabel?: string }) {
  return (
    <div className="booking-vehicle">
      <span className="booking-vehicle-icon">⌁</span>
      <span>
        <small>{vehicle.plate}</small>
        <strong>{vehicle.make} {vehicle.model} {vehicle.generation}</strong>
        <em>{vehicle.color} · {vehicle.tenantClass ?? 'класс уточняется'}</em>
      </span>
      <button onClick={onChange}>{changeLabel}</button>
    </div>
  );
}

function OfferingRow({
  item,
  selected,
  quote,
  onToggle
}: {
  item: ServiceOffering;
  selected: boolean;
  quote: BookingQuote | null;
  onToggle: () => void;
}) {
  const quoteLine = quote?.lines.find((line) => line.id === item.id);
  const included = quoteLine?.excluded;
  return (
    <article className={`offering-row ${selected ? 'selected' : ''} ${item.type === 'package' ? 'package' : ''}`} data-testid={`offering-${item.id}`}>
      <button className="offering-main" onClick={onToggle} aria-pressed={selected}>
        <span className="offer-check">{selected ? '✓' : ''}</span>
        <span className="offer-copy">
          <span className="offer-title-line">
            <strong>{item.name}</strong>
            {item.type === 'package' && <b>КОМПЛЕКС</b>}
          </span>
          <small>{item.description}</small>
          <span className="offer-meta">{formatDuration(item.durationMinutes)} · {item.operations.length} операций</span>
        </span>
        <span className="offer-price">
          {included ? <><s>{item.price.label}</s><b>В пакете</b></> : <strong>{item.price.label}</strong>}
          {item.pricingMode === 'from' && <small>после осмотра</small>}
        </span>
      </button>
      <details>
        <summary>Что входит</summary>
        <ul>{item.operations.map((operation) => <li key={operation.id}>{operation.name}</li>)}</ul>
      </details>
    </article>
  );
}

export function ServicesStep({
  vehicle,
  initialSelections,
  onBack,
  onContinue,
  title = 'Выберите услуги',
  backLabel,
  continueLabel = 'Выбрать время →',
  continueTestId = 'choose-time'
}: {
  vehicle: ServiceVehicle;
  initialSelections: QuoteSelection[];
  onBack: () => void;
  onContinue: (selections: QuoteSelection[], quote: BookingQuote) => void;
  title?: string;
  backLabel?: string;
  continueLabel?: string;
  continueTestId?: string;
}) {
  const [catalog, setCatalog] = useState<ServiceCatalog | null>(null);
  const [selections, setSelections] = useState<QuoteSelection[]>(initialSelections);
  const [quote, setQuote] = useState<BookingQuote | null>(null);
  const [loading, setLoading] = useState(true);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api.getServices(vehicle.id, controller.signal)
      .then(setCatalog)
      .catch((requestError: Error) => requestError.name !== 'AbortError' && setError(requestError.message))
      .finally(() => !controller.signal.aborted && setLoading(false));
    return () => controller.abort();
  }, [vehicle.id]);

  useEffect(() => {
    if (!selections.length) {
      setQuote(null);
      setQuoteLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setQuoteLoading(true);
      setError('');
      api.previewQuote(vehicle.id, selections, controller.signal)
        .then(setQuote)
        .catch((requestError: Error) => requestError.name !== 'AbortError' && setError(requestError.message))
        .finally(() => !controller.signal.aborted && setQuoteLoading(false));
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [selections, vehicle.id]);

  const toggle = (item: ServiceOffering) => {
    setSelections((current) => current.some((selection) => selection.type === item.type && selection.id === item.id)
      ? current.filter((selection) => !(selection.type === item.type && selection.id === item.id))
      : [...current, { type: item.type, id: item.id }]);
  };

  return (
    <section className="screen services-catalog-screen" data-testid="services-screen">
      <VehicleSummary vehicle={vehicle} onChange={onBack} changeLabel={backLabel}/>
      <div className="catalog-intro">
        <span>Класс центра: {catalog?.vehicleClass ?? vehicle.tenantClass}</span>
        <h2>{title}</h2>
        <p>Можно выбрать несколько услуг или выгодный комплекс.</p>
      </div>
      {loading && <div className="catalog-loading"><span className="spinner"/> Загружаем каталог центра</div>}
      {error && <div className="inline-error">{error}</div>}
      {catalog && !catalog.categories.some((category) => category.items.length) && <div className="login-note" role="note" data-testid="no-services">
        <strong>Услуг пока нет</strong>
        <span>Добавьте услуги центра — название, время и цену — в «Профиль → Каталог услуг» и вернитесь к записи.</span>
      </div>}
      {catalog?.categories.map((category) => (
        <div className="catalog-category" key={category.name}>
          <div className="category-heading"><h3>{category.name}</h3><span>{category.items.length}</span></div>
          <div className="offering-list">
            {category.items.map((item) => (
              <OfferingRow
                key={item.id}
                item={item}
                selected={selections.some((selection) => selection.type === item.type && selection.id === item.id)}
                quote={quote}
                onToggle={() => toggle(item)}
              />
            ))}
          </div>
        </div>
      ))}
      {quote?.warnings.map((warning) => (
        <div className="quote-warning" key={`${warning.code}-${warning.itemId}`}>ⓘ {warning.message}</div>
      ))}
      <div className="quote-dock">
        <span><small>Предварительно</small><strong>{quote ? formatMoney(quote.totalAmountMinor) : 'Выберите услуги'}</strong></span>
        {quote && <em>{formatDuration(quote.totalDurationMinutes)}</em>}
        <button data-testid={continueTestId} disabled={!quote || quoteLoading} onClick={() => quote && onContinue(selections, quote)}>
          {quoteLoading ? <span className="spinner light"/> : continueLabel}
        </button>
      </div>
    </section>
  );
}

export function ScheduleStep({
  customer,
  vehicle,
  channel,
  selections,
  quote,
  leadId,
  onBack,
  onStartIntake
}: {
  customer: Customer;
  vehicle: Vehicle;
  channel: string;
  selections: QuoteSelection[];
  quote: BookingQuote;
  leadId?: string;
  onBack: () => void;
  onStartIntake: (booking: Booking) => void;
}) {
  const dates = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() + index + 1);
    return date;
  }), []);
  const [dateKey, setDateKey] = useState(localDateKey(dates[0]));
  const [time, setTime] = useState('14:30');
  const [booking, setBooking] = useState<Booking | null>(null);
  const [availability, setAvailability] = useState<BookingAvailability | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const idempotencyKey = useRef(randomId());

  useEffect(() => {
    const controller = new AbortController();
    setAvailability(null);
    setError('');
    api.getBookingAvailability(dateKey, quote.totalDurationMinutes, controller.signal)
      .then((result) => {
        setAvailability(result);
        setTime((current) => {
          const selectedSlot = result.slots.find((slot) => slot.time === current);
          if (selectedSlot?.available) return current;
          return result.slots.find((slot) => slot.available)?.time ?? '';
        });
      })
      .catch((requestError: Error) => requestError.name !== 'AbortError' && setError(requestError.message));
    return () => controller.abort();
  }, [dateKey, quote.totalDurationMinutes]);

  const submit = async () => {
    setLoading(true);
    setError('');
    try {
      const selectedSlot = availability?.slots.find((slot) => slot.time === time && slot.available);
      if (!selectedSlot) throw new Error('Выберите доступное время');
      const created = await api.createBooking({
        ...(leadId ? { leadId } : {}),
        customerId: customer.id,
        vehicleId: vehicle.id,
        channel: channelCodes[channel] ?? 'call',
        startAt: selectedSlot.startAt,
        selections
      }, idempotencyKey.current);
      setBooking(created);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (booking) {
    const bookedDate = new Date(booking.startAt);
    return (
      <section className="screen booking-confirmed" data-testid="booking-confirmed">
        <span className="confirmation-mark">✓</span>
        <span className="confirmation-kicker">{booking.pendingSync ? 'Запись сохранена на телефоне' : 'Запись подтверждена'}</span>
        <h2>{bookedDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: booking.timezone })}, {bookedDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: booking.timezone })}</h2>
        {booking.pendingSync
          ? <p className="booking-pending-sync" data-testid="booking-pending-sync">Нет связи с сервером. Запись отправится сама, когда связь появится. Если это время за это время займут, запись сохранится с пометкой «конфликт времени».</p>
          : <p>Клиент и автомобиль уже добавлены в расписание центра.</p>}
        <VehicleSummary vehicle={vehicle} onChange={onBack}/>
        <div className="confirmation-summary">
          <div><span>Клиент</span><strong>{customer.name}</strong></div>
          <div><span>Канал</span><strong>{channel}</strong></div>
          <div><span>Предварительно</span><strong>{formatMoney(booking.preliminaryAmountMinor)}</strong></div>
          <div><span>Длительность</span><strong>{formatDuration(booking.estimatedDurationMinutes)}</strong></div>
        </div>
        <small className="booking-number">№ {booking.id.replace('booking_', '').slice(0, 8).toUpperCase()}</small>
        <button className="primary-button start-intake" data-testid="start-intake" onClick={() => onStartIntake(booking)}>Открыть приёмку →</button>
      </section>
    );
  }

  return (
    <section className="screen schedule-screen" data-testid="schedule-screen">
      <VehicleSummary vehicle={vehicle} onChange={onBack}/>
      <div className="schedule-intro"><span>Шаг 3 из 3</span><h2>Когда удобно?</h2><p>Показываем рабочее время центра. Бокс выбирать не требуется.</p></div>
      <div className="date-strip">
        {dates.map((date, index) => {
          const key = localDateKey(date);
          return <button key={key} className={dateKey === key ? 'selected' : ''} onClick={() => setDateKey(key)}>
            <small>{index === 0 ? 'Завтра' : date.toLocaleDateString('ru-RU', { weekday: 'short' })}</small>
            <strong>{date.getDate()}</strong>
            <span>{date.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '')}</span>
          </button>;
        })}
      </div>
      <div className="time-section"><h3>Свободное время</h3><div className="time-grid">
        {!availability && <span className="slots-loading"><i className="spinner"/> Проверяем график</span>}
        {availability?.slots.map((slot) => <button key={slot.time} data-testid={`slot-${slot.time}`} className={time === slot.time ? 'selected' : ''} disabled={!slot.available} onClick={() => setTime(slot.time)}>{slot.time}</button>)}
        {availability?.closed && <span className="schedule-closed">В этот день центр не работает</span>}
        {availability && !availability.closed && availability.slots.length === 0 && <span className="schedule-closed">Нет слотов для выбранной длительности</span>}
      </div></div>
      <div className="booking-recap">
        <div className="recap-heading"><span>Состав записи</span><button onClick={onBack}>Изменить</button></div>
        {quote.lines.filter((line) => !line.excluded).map((line) => <div className="recap-line" key={line.id}><span>{line.name}</span><strong>{formatMoney(line.amountMinor)}</strong></div>)}
        <div className="recap-total"><span><small>Предварительно</small><strong>{formatMoney(quote.totalAmountMinor)}</strong></span><em>{formatDuration(quote.totalDurationMinutes)}</em></div>
      </div>
      {error && <div className="inline-error">{error}</div>}
      <button className="primary-button confirm-booking" data-testid="confirm-booking" onClick={submit} disabled={loading || !availability?.slots.some((slot) => slot.time === time && slot.available)}>
        {loading ? <span className="spinner light"/> : 'Подтвердить запись'}
      </button>
    </section>
  );
}
