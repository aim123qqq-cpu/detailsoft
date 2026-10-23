import { useContext, useEffect, useRef, useState } from 'react';
import { ApiRequestError, api } from './api';
import { SessionInfo } from './session';
import type { BookingStatus, Customer, CustomerMatch, CustomerProfile, Vehicle, WorkOrder } from './types';

const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
const bookingLabels: Record<BookingStatus, { label: string; className: string }> = {
  DRAFT: { label: 'Черновик', className: 'active' },
  CONFIRMED: { label: 'Подтверждена', className: 'confirmed' },
  ARRIVED: { label: 'Приехал', className: 'ready' },
  CANCELLED: { label: 'Отменена', className: 'cancelled' },
  NO_SHOW: { label: 'Не приехал', className: 'cancelled' }
};
const orderLabels: Record<WorkOrder['status'], { label: string; className: string }> = {
  INTAKE: { label: 'Приёмка', className: 'active' },
  ESTIMATE_DRAFT: { label: 'Смета', className: 'active' },
  APPROVED: { label: 'Согласован', className: 'active' },
  IN_PROGRESS: { label: 'В работе', className: 'active' },
  QC: { label: 'В работе', className: 'active' },
  READY: { label: 'К выдаче', className: 'ready' },
  CLOSED: { label: 'Закрыт', className: 'closed' }
};
const vehicleStatusLabels: Record<Vehicle['status'], string> = { active: 'В работе', inactive: 'Неактивен', sold: 'Продан' };

function formatPhoneInput(value: string) {
  const digits = value.replace(/\D/g, '').replace(/^8/, '7').slice(0, 11);
  if (!digits) return '';
  const normalized = digits.startsWith('7') ? digits : `7${digits}`;
  const parts = [normalized.slice(1, 4), normalized.slice(4, 7), normalized.slice(7, 9), normalized.slice(9, 11)];
  let result = '+7';
  if (parts[0]) result += ` ${parts[0]}`;
  if (parts[1]) result += ` ${parts[1]}`;
  if (parts[2]) result += `-${parts[2]}`;
  if (parts[3]) result += `-${parts[3]}`;
  return result;
}

function shortId(id: string) {
  const raw = id.replace(/^order_/, '');
  return raw.length > 12 ? raw.slice(0, 8) : raw;
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
}

function plural(count: number, one: string, few: string, many: string) {
  const lastTwo = count % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (count % 10 === 1) return one;
  if (count % 10 >= 2 && count % 10 <= 4) return few;
  return many;
}

function auditText(event: CustomerProfile['audit'][number]) {
  if (event.type === 'CUSTOMER_ARCHIVED') return 'Перенесён в архив';
  if (event.type === 'CUSTOMER_REACTIVATED') return 'Возвращён из архива';
  const changes = event.details.changes ?? {};
  const parts = [
    changes.name ? `имя: ${changes.name.from} → ${changes.name.to}` : '',
    changes.phone ? `телефон: ${changes.phone.from} → ${changes.phone.to}` : ''
  ].filter(Boolean);
  return `Изменены контакты${parts.length ? ` — ${parts.join(', ')}` : ''}`;
}

export function CustomerProfileScreen({ customerId, backLabel, onBack, onOpenVehicle, onOpenCustomer, onBook }: {
  customerId: string;
  backLabel: string;
  onBack: () => void;
  onOpenVehicle: (vehicleId: string) => void;
  onOpenCustomer: (customerId: string) => void;
  onBook: (customer: Customer, vehicle: Vehicle) => void;
}) {
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [duplicates, setDuplicates] = useState<CustomerMatch[]>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [blockers, setBlockers] = useState<null | { confirmedBookings: number; openOrders: number; activeLeads: number }>(null);
  const [revision, setRevision] = useState(0);
  const [eraseOpen, setEraseOpen] = useState(false);
  const canErase = Boolean(useContext(SessionInfo)?.capabilities.manageSettings);
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api.getCustomerProfile(customerId, controller.signal)
      .then(setProfile)
      .catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [customerId, revision]);

  useEffect(() => {
    setEditing(false); setArchiveOpen(false); setDuplicates([]); setBlockers(null); setSuccess('');
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [customerId]);

  useEffect(() => {
    if (editing) nameInput.current?.focus();
  }, [editing]);

  if (loading && !profile) return <section className="screen customer-profile-screen"><div className="workspace-state"><span className="spinner"/> Загружаем карточку клиента</div></section>;
  if (!profile) return (
    <section className="screen customer-profile-screen">
      <button className="details-back" onClick={onBack}>← {backLabel}</button>
      <div className="workspace-state error-state"><strong>Карточка недоступна</strong><span>{error}</span><button onClick={() => setRevision((value) => value + 1)}>Повторить</button></div>
    </section>
  );

  const { customer, stats } = profile;
  const activeVehicles = profile.vehicles.filter((vehicle) => vehicle.active);
  const inactiveVehicles = profile.vehicles.filter((vehicle) => !vehicle.active);
  const trimmedName = name.trim();
  const phoneDigits = phone.replace(/\D/g, '');
  const nameChanged = trimmedName !== customer.name;
  const phoneChanged = phone !== customer.phoneDisplay;
  const formValid = trimmedName.length >= 2 && trimmedName.length <= 120 && phoneDigits.length >= 11;

  const openEditor = () => {
    setName(customer.name);
    setPhone(customer.phoneDisplay);
    setDuplicates([]);
    setSuccess('');
    setError('');
    setArchiveOpen(false);
    setEditing(true);
  };

  const saveContacts = async (confirmDuplicate = false) => {
    if (!nameChanged && !phoneChanged) { setEditing(false); return; }
    setBusy(true); setError('');
    try {
      const updated = await api.updateCustomer(customer.id, {
        ...(nameChanged ? { name: trimmedName } : {}),
        ...(phoneChanged ? { phone } : {}),
        ...(confirmDuplicate ? { confirmDuplicate: true } : {})
      });
      setProfile(updated);
      setEditing(false);
      setDuplicates([]);
      setSuccess('Контакты обновлены');
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.code === 'possible_duplicate') {
        setDuplicates((requestError.details.matches as CustomerMatch[] | undefined) ?? []);
      } else setError((requestError as Error).message);
    } finally { setBusy(false); }
  };

  // The customer asked to destroy their data (152-FZ art. 21): only an owner or an administrator, after a warning.
  const erase = async () => {
    setBusy(true); setError(''); setBlockers(null);
    try {
      await api.eraseCustomer(customer.id);
      setEraseOpen(false);
      setSuccess('Данные клиента удалены. Заказы остались без персональных данных.');
      setRevision((value) => value + 1);
      window.scrollTo({ top: 0, behavior: 'auto' });
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.code === 'customer_has_active_work') {
        setBlockers(requestError.details as { confirmedBookings: number; openOrders: number; activeLeads: number });
      } else setError((requestError as Error).message);
    } finally { setBusy(false); }
  };

  const changeArchive = async (archived: boolean) => {
    setBusy(true); setError(''); setBlockers(null);
    try {
      setProfile(await api.setCustomerArchived(customer.id, archived));
      setArchiveOpen(false);
      setSuccess(archived ? 'Клиент перенесён в архив' : 'Клиент возвращён из архива');
      window.scrollTo({ top: 0, behavior: 'auto' });
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.code === 'customer_has_active_work') {
        setBlockers(requestError.details as { confirmedBookings: number; openOrders: number; activeLeads: number });
      } else setError((requestError as Error).message);
    } finally { setBusy(false); }
  };

  const bookingCustomer: Customer = {
    id: customer.id, name: customer.name, phoneDisplay: customer.phoneDisplay, visitCount: stats.closedOrders, vehicles: activeVehicles
  };

  return (
    <section className="screen customer-profile-screen" data-testid="customer-profile">
      <button className="details-back" onClick={onBack}>← {backLabel}</button>
      <div className={`customer-profile-hero ${customer.archived ? 'archived' : ''}`}>
        <b className="customer-initials" aria-hidden="true">{initials(customer.name)}</b>
        <div>
          <span>Карточка клиента</span>
          <h2 data-testid="customer-profile-name">{customer.name}</h2>
          <a href={`tel:${customer.phoneDisplay}`}>{customer.phoneDisplay}</a>
        </div>
        {customer.archived && <small className="customer-archived-badge">В архиве</small>}
      </div>

      {success && <div className="vehicle-success" role="status">✓ {success}</div>}
      {error && <div className="form-error" role="alert">{error}</div>}

      {customer.archived && <div className="customer-note archived-note" data-testid="customer-archived-note">
        <strong>Клиент в архиве{customer.archivedAt ? ` с ${dateFormat.format(new Date(customer.archivedAt))}` : ''}</strong>
        <span>Он не появляется в обычном поиске и не принимает новые записи. Автомобили, записи и заказы сохранены.</span>
      </div>}

      {profile.phoneDuplicates.length > 0 && <div className="customer-note duplicate-note" data-testid="customer-duplicate-note">
        <strong>Этот телефон указан ещё у {profile.phoneDuplicates.length} {plural(profile.phoneDuplicates.length, 'клиента', 'клиентов', 'клиентов')}</strong>
        <span>Записи не объединяются автоматически. Проверьте, не один ли это человек.</span>
        <div className="customer-match-list">{profile.phoneDuplicates.map((match) => (
          <button key={match.id} onClick={() => onOpenCustomer(match.id)}><b>{match.name}</b><small>{match.phoneDisplay}{match.archived ? ' · в архиве' : ''}</small><i>›</i></button>
        ))}</div>
      </div>}

      <div className="vehicle-profile-stats customer-profile-stats">
        <div><strong>{stats.closedOrders}</strong><span>{plural(stats.closedOrders, 'визит', 'визита', 'визитов')}</span></div>
        <div><strong>{stats.activeOrders}</strong><span>в работе</span></div>
        <div><strong>{stats.openBookings}</strong><span>{plural(stats.openBookings, 'запись', 'записи', 'записей')} впереди</span></div>
      </div>

      <article className="customer-section">
        <div className="vehicle-section-heading"><span>Контакты</span>{stats.lastVisitAt && <i>последний визит {dateFormat.format(new Date(stats.lastVisitAt))}</i>}</div>
        {!editing ? <>
          <dl className="customer-contacts">
            <div><dt>Имя</dt><dd>{customer.name}</dd></div>
            <div><dt>Телефон</dt><dd>{customer.phoneDisplay}</dd></div>
            <div><dt>Клиент с</dt><dd>{dateFormat.format(new Date(customer.createdAt))}</dd></div>
          </dl>
          {!customer.archived && <button className="customer-secondary" data-testid="edit-customer" onClick={openEditor}>Изменить контакты</button>}
        </> : <form className="customer-edit" data-testid="customer-edit" onSubmit={(event) => { event.preventDefault(); void saveContacts(); }}>
          <label htmlFor="customer-name">Имя</label>
          <input id="customer-name" ref={nameInput} data-testid="customer-name-input" value={name} autoComplete="off" maxLength={120} onChange={(event) => { setName(event.target.value); setDuplicates([]); }}/>
          <label htmlFor="customer-phone">Телефон</label>
          <input id="customer-phone" data-testid="customer-phone-input" value={phone} inputMode="tel" autoComplete="off" onChange={(event) => { setPhone(formatPhoneInput(event.target.value)); setDuplicates([]); }}/>
          <p className="customer-hint">Изменение телефона не переносит автомобили и не меняет прошлые записи и заказы.</p>
          {duplicates.length > 0 && <div className="customer-note duplicate-note" role="alert" data-testid="customer-duplicate-warning">
            <strong>Номер уже есть в базе</strong>
            <span>Если это тот же человек, откройте его карточку. Если другой, сохраните явно: записи не объединятся.</span>
            <div className="customer-match-list">{duplicates.map((match) => (
              <button type="button" key={match.id} onClick={() => onOpenCustomer(match.id)}><b>{match.name}</b><small>{match.phoneDisplay}{match.archived ? ' · в архиве' : ''}</small><i>›</i></button>
            ))}</div>
            <button type="button" className="customer-confirm" data-testid="confirm-duplicate-save" disabled={busy} onClick={() => saveContacts(true)}>Это другой клиент, сохранить</button>
          </div>}
          <div className="customer-edit-actions">
            <button type="button" onClick={() => { setEditing(false); setDuplicates([]); }}>Отмена</button>
            <button type="submit" data-testid="save-customer" disabled={busy || !formValid || duplicates.length > 0}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
          </div>
        </form>}
      </article>

      <article className="customer-section">
        <div className="vehicle-section-heading"><span>Автомобили</span><i>{profile.vehicles.length}</i></div>
        {profile.vehicles.length === 0 && <p className="vehicle-empty">Автомобили не привязаны.</p>}
        <div className="customer-vehicles">
          {[...activeVehicles, ...inactiveVehicles].map((vehicle) => (
            <div key={vehicle.id} className={`customer-vehicle ${vehicle.active ? '' : 'inactive'}`} data-testid={`customer-vehicle-${vehicle.id}`}>
              <span className="customer-vehicle-copy">
                <strong>{vehicle.make} {vehicle.model} {vehicle.generation}</strong>
                <small>{vehicle.color}{vehicle.tenantClass ? ` · класс ${vehicle.tenantClass}` : ''}{vehicle.active ? '' : ` · ${vehicleStatusLabels[vehicle.status]}`}</small>
              </span>
              <span className="plate">{vehicle.plate}</span>
              <div className="customer-vehicle-actions">
                <button data-testid={`customer-open-vehicle-${vehicle.id}`} onClick={() => onOpenVehicle(vehicle.id)}>История авто</button>
                {vehicle.active && !customer.archived && <button className="primary" data-testid={`customer-book-${vehicle.id}`} onClick={() => onBook(bookingCustomer, vehicle)}>Записать</button>}
              </div>
            </div>
          ))}
        </div>
        {profile.formerVehicles.length > 0 && <>
          <div className="customer-subheading">Ранее принадлежали</div>
          <div className="customer-former">
            {profile.formerVehicles.map((link) => (
              <button key={link.linkId} data-testid={`customer-former-${link.vehicle.id}`} onClick={() => onOpenVehicle(link.vehicle.id)}>
                <span><strong>{link.vehicle.make} {link.vehicle.model}</strong><small>{dateFormat.format(new Date(link.validFrom))} — {dateFormat.format(new Date(link.validTo))}{link.currentOwner ? ` · сейчас у ${link.currentOwner.name}` : ''}</small></span>
                <span className="plate">{link.vehicle.plate}</span>
              </button>
            ))}
          </div>
        </>}
      </article>

      <article className="customer-section">
        <div className="vehicle-section-heading"><span>Записи</span><i>{stats.bookings}</i></div>
        {profile.bookings.length === 0 ? <p className="vehicle-empty">Записей пока нет.</p> : <div className="customer-history">
          {profile.bookings.map((booking) => {
            const status = bookingLabels[booking.status];
            return <div key={booking.id}>
              <span><strong>{dateTimeFormat.format(new Date(booking.startAt))}</strong><small>{booking.vehicle.make} {booking.vehicle.model} · {booking.vehicle.plate}{booking.orderId ? ' · есть заказ' : ''}</small></span>
              <span className={`status-pill ${status.className}`}>{status.label}</span>
            </div>;
          })}
        </div>}
      </article>

      <article className="customer-section">
        <div className="vehicle-section-heading"><span>Заказы</span><i>{stats.orders}</i></div>
        {profile.orders.length === 0 ? <p className="vehicle-empty">Заказов пока нет.</p> : <div className="customer-history">
          {profile.orders.map((order) => {
            const status = orderLabels[order.status];
            return <div key={order.id} data-testid={`customer-order-${order.id}`}>
              <span><strong>Заказ #{shortId(order.id)}</strong><small>{dateFormat.format(new Date(order.createdAt))} · {order.vehicle.make} {order.vehicle.model} · {order.vehicle.plate}{order.totalAmountMinor !== null ? ` · смета ${money.format(order.totalAmountMinor / 100)}` : ''}</small></span>
              <span className={`status-pill ${status.className}`}>{status.label}</span>
            </div>;
          })}
        </div>}
      </article>

      {profile.audit.length > 0 && <article className="customer-section">
        <div className="vehicle-section-heading"><span>Журнал изменений</span><i>{profile.audit.length}</i></div>
        <div className="customer-audit">{profile.audit.map((event) => (
          <div key={event.id}><strong>{auditText(event)}</strong><small>{dateTimeFormat.format(new Date(event.createdAt))}{event.actorName ? ` · ${event.actorName}` : ''}</small></div>
        ))}</div>
      </article>}

      <article className="customer-section customer-archive-zone">
        {customer.archived && customer.name === 'Удалённый клиент' ? <p>Данные клиента удалены по его просьбе. Заказы сохранены без персональных данных.</p> : customer.archived ? <>
          <p>Возврат из архива снова покажет клиента в поиске и позволит создавать записи.</p>
          <button className="customer-secondary" data-testid="reactivate-customer" disabled={busy} onClick={() => changeArchive(false)}>{busy ? 'Возвращаем…' : 'Вернуть из архива'}</button>
        </> : !archiveOpen ? (
          <button className="customer-danger" data-testid="open-archive-customer" onClick={() => { setArchiveOpen(true); setBlockers(null); setEditing(false); setSuccess(''); }}>Перенести в архив</button>
        ) : <div className="customer-archive-confirm" data-testid="archive-confirm">
          <strong>Перенести клиента в архив?</strong>
          <p>{customer.name} пропадёт из поиска для новых записей. Автомобили, история владения, записи и заказы не удаляются и не переписываются.</p>
          {blockers && <div className="customer-note blocker-note" role="alert" data-testid="archive-blockers">
            <strong>Сейчас архивировать нельзя</strong>
            <span>{[
              blockers.confirmedBookings ? `подтверждённых записей: ${blockers.confirmedBookings}` : '',
              blockers.openOrders ? `незакрытых заказов: ${blockers.openOrders}` : '',
              blockers.activeLeads ? `активных обращений: ${blockers.activeLeads}` : ''
            ].filter(Boolean).join(', ')}. Завершите или отмените их.</span>
          </div>}
          <div className="customer-edit-actions">
            <button onClick={() => { setArchiveOpen(false); setBlockers(null); }}>Оставить</button>
            <button className="danger" data-testid="confirm-archive-customer" disabled={busy || Boolean(blockers)} onClick={() => changeArchive(true)}>{busy ? 'Переносим…' : 'В архив'}</button>
          </div>
        </div>}
      </article>

      {canErase && customer.name !== 'Удалённый клиент' && <article className="customer-section customer-archive-zone">
        {!eraseOpen ? <button className="customer-danger" data-testid="open-erase-customer" onClick={() => { setEraseOpen(true); setArchiveOpen(false); setBlockers(null); setSuccess(''); }}>Удалить данные клиента</button>
        : <div className="customer-archive-confirm" data-testid="erase-confirm">
          <strong>Удалить персональные данные клиента?</strong>
          <p>Так исполняется просьба клиента удалить его данные. Будут удалены имя и телефон, госномера его автомобилей, фото автомобилей в его заказах, имя и подпись в актах. Заказы, суммы и выполненные работы останутся без персональных данных. Отменить нельзя; из резервных копий данные исчезнут через 7 дней.</p>
          {blockers && <div className="customer-note blocker-note" role="alert">
            <strong>Сейчас удалить нельзя</strong>
            <span>{[
              blockers.confirmedBookings ? `подтверждённых записей: ${blockers.confirmedBookings}` : '',
              blockers.openOrders ? `незакрытых заказов: ${blockers.openOrders}` : '',
              blockers.activeLeads ? `активных обращений: ${blockers.activeLeads}` : ''
            ].filter(Boolean).join(', ')}. Завершите или отмените их.</span>
          </div>}
          <div className="customer-edit-actions">
            <button onClick={() => { setEraseOpen(false); setBlockers(null); }}>Не удалять</button>
            <button className="danger" data-testid="confirm-erase-customer" disabled={busy || Boolean(blockers)} onClick={erase}>{busy ? 'Удаляем…' : 'Удалить навсегда'}</button>
          </div>
        </div>}
      </article>}
    </section>
  );
}
