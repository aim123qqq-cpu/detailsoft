import { useEffect, useState } from 'react';
import { api } from './api';
import type { ReminderSettings } from './types';

const BEFORE: { value: ReminderSettings['beforeMinutes']; label: string }[] = [
  { value: null, label: 'Не напоминать' }, { value: 15, label: '15 мин' }, { value: 30, label: '30 мин' },
  { value: 60, label: '1 час' }, { value: 120, label: '2 часа' }, { value: 180, label: '3 часа' }
];

/** What the center's people are reminded of: before each booking, the plan of the day, tomorrow's bookings. */
export function RemindersPanel() {
  const [value, setValue] = useState<ReminderSettings | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api.getReminderSettings(controller.signal).then(setValue).catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); });
    return () => controller.abort();
  }, []);

  if (!value) return error ? <p className="form-error">{error}</p> : null;
  const change = (next: ReminderSettings) => { setValue(next); setSaved(false); };
  const save = async () => {
    setSaving(true); setError('');
    try { setValue(await api.updateReminderSettings(value)); setSaved(true); }
    catch (requestError) { setError((requestError as Error).message); }
    finally { setSaving(false); }
  };
  const digest = (key: 'morning' | 'evening', title: string, note: string) => (
    <div className="reminder-digest">
      <label className="notification-toggle">
        <span><b>{title}</b><small>{note}</small></span>
        <input type="checkbox" role="switch" data-testid={`reminder-${key}`} checked={value[key].enabled} onChange={(event) => change({ ...value, [key]: { ...value[key], enabled: event.target.checked } })}/>
      </label>
      {value[key].enabled && <input type="time" aria-label={`Время: ${title}`} value={value[key].time} onChange={(event) => change({ ...value, [key]: { ...value[key], time: event.target.value } })}/>}
    </div>
  );

  return (
    <section className="settings-panel reminders-panel" data-testid="reminders-panel">
      <div className="settings-panel-heading"><span>Напоминания о записях</span><strong>сотрудникам</strong></div>
      <p>Приходят тем, кто ведёт записи: в DetailFlow и копией в Telegram или MAX. Имён и телефонов клиентов в них нет — только время, автомобиль и длительность.</p>
      <span className="reminders-label">Перед каждой записью</span>
      <div className="slot-step-picker reminder-before">{BEFORE.map((option) => (
        <button key={String(option.value)} className={value.beforeMinutes === option.value ? 'selected' : ''} onClick={() => change({ ...value, beforeMinutes: option.value })}>{option.label}</button>
      ))}</div>
      {digest('morning', 'План дня утром', 'Список записей на сегодня')}
      {digest('evening', 'Сводка вечером', 'Сколько записей завтра и первая по времени')}
      {error && <p className="form-error">{error}</p>}
      {saved && <div className="settings-saved" role="status">✓ Напоминания сохранены.</div>}
      <button className="primary-button" data-testid="save-reminders" disabled={saving} onClick={save}>{saving ? 'Сохраняем…' : 'Сохранить напоминания'}</button>
    </section>
  );
}
