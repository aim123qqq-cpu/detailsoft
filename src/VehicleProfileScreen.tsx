import { useEffect, useState } from 'react';
import { api } from './api';
import type { Customer, VehicleProfile } from './types';

const statusLabels = { active: 'В работе', inactive: 'Неактивен', sold: 'Продан' } as const;

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
}

function formatPhone(value: string) {
  const digits = value.replace(/\D/g, '').replace(/^8/, '7').slice(0, 11);
  if (!digits) return '';
  const normalized = digits.startsWith('7') ? digits : `7${digits}`;
  return `+7 ${normalized.slice(1, 4)} ${normalized.slice(4, 7)}-${normalized.slice(7, 9)}-${normalized.slice(9, 11)}`.replace(/[- ]+$/, '');
}

export function VehicleProfileScreen({ vehicleId, onBack }: { vehicleId: string; onBack: () => void }) {
  const [profile, setProfile] = useState<VehicleProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [transferOpen, setTransferOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [candidates, setCandidates] = useState<Customer[]>([]);
  const [candidate, setCandidate] = useState<Customer | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState('');

  const load = async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      setProfile(await api.getVehicleProfile(vehicleId, signal));
    } catch (requestError) {
      if ((requestError as Error).name !== 'AbortError') setError((requestError as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [vehicleId]);

  useEffect(() => {
    setCandidate(null);
    if (!transferOpen || phone.replace(/\D/g, '').length < 4) return setCandidates([]);
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.searchCustomers(phone, controller.signal);
        setCandidates(result.items.filter((item) => item.id !== profile?.currentOwner?.id));
      } catch (requestError) {
        if ((requestError as Error).name !== 'AbortError') setError((requestError as Error).message);
      }
    }, 280);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [phone, transferOpen, profile?.currentOwner?.id]);

  const changeStatus = async (status: 'active' | 'sold') => {
    setBusy(true);
    setError('');
    try {
      await api.updateVehicleStatus(vehicleId, status);
      await load();
      setSuccess(status === 'active' ? 'Автомобиль возвращён в работу' : 'Автомобиль отмечен как проданный');
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const transfer = async () => {
    if (!candidate) return;
    setBusy(true);
    setError('');
    try {
      const updated = await api.transferVehicle(vehicleId, candidate.id);
      setProfile(updated);
      setSuccess(`Владелец изменён: ${candidate.name}`);
      setTransferOpen(false);
      setPhone('');
      setCandidate(null);
      setCandidates([]);
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !profile) return <section className="screen vehicle-profile-screen"><div className="workspace-state">Загружаем карточку автомобиля…</div></section>;
  if (!profile) return <section className="screen vehicle-profile-screen"><button className="details-back" onClick={onBack}>← К поиску</button><div className="form-error">{error || 'Карточка недоступна'}</div></section>;

  const { vehicle } = profile;
  return (
    <section className="screen vehicle-profile-screen" data-testid="vehicle-profile">
      <button className="details-back" onClick={onBack}>← К результатам поиска</button>
      <div className="vehicle-profile-hero">
        <div className="vehicle-profile-mark">⌁</div>
        <div><span>Карточка автомобиля</span><h2>{vehicle.make} {vehicle.model} {vehicle.generation}</h2><p>{vehicle.color} · {vehicle.tenantClass ?? 'Класс не задан'}</p></div>
        <strong>{vehicle.plate}</strong>
        <small className={`vehicle-status ${vehicle.status}`}>{statusLabels[vehicle.status]}</small>
      </div>

      {success && <div className="vehicle-success" role="status">✓ {success}</div>}
      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="vehicle-profile-stats">
        <div><strong>{profile.visits.length}</strong><span>визитов</span></div>
        <div><strong>{profile.ownership.length}</strong><span>владельцев</span></div>
        <div><strong>{profile.audit.length}</strong><span>изменений</span></div>
      </div>

      <article className="vehicle-owner-card">
        <div className="vehicle-section-heading"><span>Текущий владелец</span><i>активная связь</i></div>
        {profile.currentOwner ? <div className="vehicle-owner-row"><b>{profile.currentOwner.name.slice(0, 2).toUpperCase()}</b><span><strong>{profile.currentOwner.name}</strong><small>{profile.currentOwner.phoneDisplay}</small></span></div> : <p>Владелец не указан</p>}
        <div className="vehicle-owner-actions">
          <button data-testid="open-transfer" onClick={() => { setTransferOpen((value) => !value); setSuccess(''); }}>{transferOpen ? 'Отменить перенос' : 'Сменить владельца'}</button>
          <button disabled={busy} onClick={() => changeStatus(vehicle.status === 'active' ? 'sold' : 'active')}>{vehicle.status === 'active' ? 'Отметить проданным' : 'Вернуть в работу'}</button>
        </div>
      </article>

      {transferOpen && <div className="vehicle-transfer" data-testid="vehicle-transfer">
        <span>Новый владелец</span>
        <h3>Найдите существующего клиента</h3>
        <p>Связь с текущим владельцем закроется, но история визитов останется без изменений.</p>
        <label>Телефон клиента<input data-testid="transfer-phone" value={phone} inputMode="tel" placeholder="+7 999 000-00-00" onChange={(event) => setPhone(formatPhone(event.target.value))}/></label>
        <div className="transfer-candidates">
          {candidates.map((item) => <button key={item.id} data-testid={`transfer-customer-${item.id}`} className={candidate?.id === item.id ? 'selected' : ''} onClick={() => setCandidate(item)}><b>{item.name}</b><small>{item.phoneDisplay} · {item.visitCount} визитов</small><i>{candidate?.id === item.id ? '✓' : '›'}</i></button>)}
          {phone.replace(/\D/g, '').length >= 4 && candidates.length === 0 && <small>Подходящий клиент не найден. Автоматически создавать или объединять записи не будем.</small>}
        </div>
        {candidate && <div className="transfer-confirm">
          <p>Передать <strong>{vehicle.plate}</strong> клиенту <strong>{candidate.name}</strong>?</p>
          <button data-testid="confirm-transfer" disabled={busy} onClick={transfer}>{busy ? 'Сохраняем…' : 'Подтвердить смену владельца'}</button>
        </div>}
      </div>}

      <div className="vehicle-history-section">
        <div className="vehicle-section-heading"><span>История владельцев</span><i>{profile.ownership.length}</i></div>
        <div className="vehicle-timeline">
          {profile.ownership.map((item) => <div key={item.linkId} className={item.active ? 'active' : ''}><i/><span><strong>{item.customer.name}</strong><small>{item.active ? `с ${formatDate(item.validFrom)} · сейчас` : `${formatDate(item.validFrom)} — ${formatDate(item.validTo!)}`}</small></span><b>{item.active ? 'Владелец' : 'Архив'}</b></div>)}
        </div>
      </div>

      <div className="vehicle-history-section">
        <div className="vehicle-section-heading"><span>Визиты и заказы</span><i>{profile.visits.length}</i></div>
        {profile.visits.length ? <div className="vehicle-visits">{profile.visits.map((visit) => <div key={visit.id}><span><strong>Заказ {visit.id.replace('order_', '#')}</strong><small>{formatDate(visit.createdAt)} · {visit.customer.name}</small></span><b>{visit.status === 'CLOSED' ? 'Закрыт' : visit.status}</b></div>)}</div> : <p className="vehicle-empty">Визитов пока нет</p>}
      </div>
    </section>
  );
}
