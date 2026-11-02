import { useEffect, useState } from 'react';
import { api } from './api';
import { disablePush, enablePush, pushState, type PushState } from './devicePush';
import type { AppNotification, NotificationPrefs } from './types';

const timeFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// Stored as SQLite UTC time without a zone.
const parseTime = (value: string) => new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);

/** The member's feed: reminders, the plan of the day, messages from DetailFlow; and what they want to get. */
export function NotificationsScreen({ onOpenBookings, onRead }: { onOpenBookings: () => void; onRead: () => void }) {
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [error, setError] = useState('');
  const [device, setDevice] = useState<PushState | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);
  useEffect(() => { pushState().then(setDevice, () => setDevice('unsupported')); }, []);
  const switchDevice = async (on: boolean) => {
    setDeviceBusy(true); setError('');
    try { setDevice(on ? await enablePush() : await disablePush()); }
    catch (requestError) { setError((requestError as Error).message || 'Не удалось включить уведомления на этом устройстве'); }
    finally { setDeviceBusy(false); }
  };

  useEffect(() => {
    const controller = new AbortController();
    api.getNotifications(controller.signal).then(async (feed) => {
      setItems(feed.items);
      // Opening the feed is reading it: the badge goes away, the new ones stay marked here until next time.
      if (feed.unread) { await api.markNotificationsRead().catch(() => {}); onRead(); }
    }).catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); });
    api.getNotificationPrefs(controller.signal).then(setPrefs).catch(() => {});
    return () => controller.abort();
  }, [onRead]);

  const toggle = async (key: keyof NotificationPrefs) => {
    if (!prefs) return;
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    try { setPrefs(await api.updateNotificationPrefs({ [key]: next[key] })); }
    catch (requestError) { setPrefs(prefs); setError((requestError as Error).message); }
  };

  return (
    <section className="screen notifications-screen" data-testid="notifications-screen">
      {error && <p className="form-error" role="alert">{error}</p>}
      {!items && !error && <div className="workspace-state"><span className="spinner"/> Загружаем уведомления</div>}
      {items?.length === 0 && <div className="workspace-state"><strong>Уведомлений пока нет</strong><span>Здесь появятся напоминания о записях, план дня и новости DetailFlow.</span></div>}
      {items && items.length > 0 && <ol className="notification-list">
        {items.map((item) => (
          <li key={item.id} className={item.read ? '' : 'unread'} data-testid="notification">
            <button disabled={!item.link?.startsWith('/bookings')} onClick={onOpenBookings}>
              <span className={`notification-kind ${item.kind}`} aria-hidden="true"/>
              <span>
                <b>{item.title}</b>
                {item.body && <span className="notification-body">{item.body}</span>}
                <small>{timeFormat.format(parseTime(item.createdAt))}{item.kind === 'broadcast' ? ' · DetailFlow' : ''}</small>
              </span>
            </button>
          </li>
        ))}
      </ol>}

      {prefs && <section className="settings-panel notification-prefs" aria-label="Что присылать">
        <div className="settings-panel-heading"><span>Что присылать мне</span></div>
        {device && device !== 'unsupported' && <label className="notification-toggle" data-testid="device-push">
          <span><b>Уведомления на этом устройстве</b><small>{device === 'ios-tab'
            ? 'На iPhone работают, когда DetailFlow добавлен на экран «Домой»: «Поделиться» → «На экран „Домой“».'
            : device === 'denied' ? 'Запрещены в настройках браузера для detailflow.ru — разрешите их там.' : 'Всплывают, даже когда DetailFlow закрыт'}</small></span>
          {(device === 'on' || device === 'off') && <input type="checkbox" role="switch" data-testid="pref-device" checked={device === 'on'} disabled={deviceBusy} onChange={(event) => void switchDevice(event.target.checked)}/>}
        </label>}
        {([
          ['reminders', 'Напоминания о записях', 'Перед записью и план дня — как настроил центр'],
          ['news', 'Новости и опросы DetailFlow', 'Обновления сервиса и короткие вопросы о работе'],
          ['viaMessenger', 'Дублировать в Telegram или MAX', 'Если вход привязан к мессенджеру']
        ] as const).map(([key, title, note]) => (
          <label key={key} className="notification-toggle">
            <span><b>{title}</b><small>{note}</small></span>
            <input type="checkbox" role="switch" data-testid={`pref-${key}`} checked={prefs[key]} onChange={() => void toggle(key)}/>
          </label>
        ))}
      </section>}
    </section>
  );
}
