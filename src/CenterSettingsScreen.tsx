import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { RequisitesPanel } from './RequisitesPanel';
import type { CenterSettings } from './types';

const days = [
  { value: 1, short: 'Пн', label: 'Понедельник' },
  { value: 2, short: 'Вт', label: 'Вторник' },
  { value: 3, short: 'Ср', label: 'Среда' },
  { value: 4, short: 'Чт', label: 'Четверг' },
  { value: 5, short: 'Пт', label: 'Пятница' },
  { value: 6, short: 'Сб', label: 'Суббота' },
  { value: 0, short: 'Вс', label: 'Воскресенье' }
];

function timeMinutes(value: string) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function CenterSettingsScreen({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<CenterSettings | null>(null);
  const [workingDays, setWorkingDays] = useState<number[]>([]);
  const [openTime, setOpenTime] = useState('09:00');
  const [closeTime, setCloseTime] = useState('20:00');
  const [slotStepMinutes, setSlotStepMinutes] = useState<CenterSettings['slotStepMinutes']>(30);
  const [simultaneousCapacity, setSimultaneousCapacity] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api.getCenterSettings(controller.signal).then((result) => {
      setSettings(result);
      setWorkingDays(result.workingDays);
      setOpenTime(result.openTime);
      setCloseTime(result.closeTime);
      setSlotStepMinutes(result.slotStepMinutes);
      setSimultaneousCapacity(result.simultaneousCapacity);
      titleRef.current?.focus();
    }).catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); });
    return () => controller.abort();
  }, [revision]);

  const toggleDay = (value: number) => {
    setSaved(false);
    setWorkingDays((current) => current.includes(value) ? current.filter((day) => day !== value) : [...current, value]);
  };
  const valid = workingDays.length > 0 && timeMinutes(closeTime) - timeMinutes(openTime) >= 60;
  const slotCount = valid ? Math.max(0, Math.floor((timeMinutes(closeTime) - timeMinutes(openTime)) / slotStepMinutes)) : 0;

  const save = async () => {
    setSaving(true); setSaved(false); setError('');
    try {
      const result = await api.updateCenterSettings({ workingDays, openTime, closeTime, slotStepMinutes, simultaneousCapacity });
      setSettings(result);
      setSaved(true);
    } catch (requestError) { setError((requestError as Error).message); }
    finally { setSaving(false); }
  };

  return <section className="screen center-settings-screen" data-testid="center-settings-screen">
    <button className="details-back" onClick={onBack}>← Профиль</button>
    <div className="center-settings-hero">
      <span>Работа центра</span>
      <h2 ref={titleRef} tabIndex={-1}>График и загрузка</h2>
      <p>Эти параметры определяют свободные слоты. Выделенные боксы не обязательны.</p>
    </div>
    {!settings && !error && <div className="workspace-state"><span className="spinner"/> Загружаем настройки</div>}
    {!settings && error && <div className="workspace-state error-state"><strong>Не удалось загрузить</strong><span>{error}</span><button onClick={() => setRevision((value) => value + 1)}>Повторить</button></div>}
    {settings && <>
      <section className="settings-panel">
        <div className="settings-panel-heading"><span>Рабочие дни</span><strong>{workingDays.length} из 7</strong></div>
        <div className="working-days" role="group" aria-label="Рабочие дни">{days.map((day) => <button key={day.value} aria-label={day.label} aria-pressed={workingDays.includes(day.value)} className={workingDays.includes(day.value) ? 'selected' : ''} onClick={() => toggleDay(day.value)}>{day.short}</button>)}</div>
      </section>
      <section className="settings-panel schedule-hours">
        <div className="settings-panel-heading"><span>Часы работы</span><strong>{settings.timezone === 'Europe/Moscow' ? 'UTC+3' : settings.timezone}</strong></div>
        <div><label>Открытие<input aria-label="Время открытия" type="time" value={openTime} onChange={(event) => { setOpenTime(event.target.value); setSaved(false); }}/></label><span>→</span><label>Закрытие<input aria-label="Время закрытия" type="time" value={closeTime} onChange={(event) => { setCloseTime(event.target.value); setSaved(false); }}/></label></div>
        {!valid && <p className="form-error">Выберите хотя бы один день и минимум час работы.</p>}
      </section>
      <section className="settings-panel">
        <div className="settings-panel-heading"><span>Шаг записи</span><strong>{slotCount} слотов в день</strong></div>
        <div className="slot-step-picker">{([15, 30, 60, 90, 120] as const).map((value) => <button key={value} className={slotStepMinutes === value ? 'selected' : ''} onClick={() => { setSlotStepMinutes(value); setSaved(false); }}>{value} мин</button>)}</div>
      </section>
      <section className="settings-panel capacity-panel">
        <div><span>Одновременная загрузка</span><p>Сколько автомобилей центр может обслуживать одновременно — без привязки к конкретным боксам.</p></div>
        <div className="capacity-control"><button aria-label="Уменьшить вместимость" disabled={simultaneousCapacity <= 1} onClick={() => { setSimultaneousCapacity((value) => value - 1); setSaved(false); }}>−</button><strong>{simultaneousCapacity}<small>{simultaneousCapacity === 1 ? 'автомобиль' : simultaneousCapacity < 5 ? 'автомобиля' : 'автомобилей'}</small></strong><button aria-label="Увеличить вместимость" disabled={simultaneousCapacity >= 20} onClick={() => { setSimultaneousCapacity((value) => value + 1); setSaved(false); }}>+</button></div>
      </section>
      {error && <p className="form-error">{error}</p>}
      {saved && <div className="settings-saved" role="status">✓ График сохранён. Новые слоты уже пересчитаны.</div>}
      <button className="primary-button settings-save" data-testid="save-center-settings" disabled={!valid || saving} onClick={save}>{saving ? 'Сохраняем…' : 'Сохранить настройки'}</button>
      <RequisitesPanel/>
    </>}
  </section>;
}
