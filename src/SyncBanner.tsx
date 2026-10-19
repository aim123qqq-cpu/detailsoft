import { useState } from 'react';
import { confirmFailedDuplicate, discardFailed, linkFailedToExisting, retryFailed, useSyncState } from './offline/sync';
import { pluralRu } from './format';

const changes = (count: number) => `${count} ${pluralRu(count, 'изменение', 'изменения', 'изменений')}`;

/** Connection and offline-queue status on top of every screen. */
export function SyncBanner({ online }: { online: boolean }) {
  const { reachable, syncing, pending, failed } = useSyncState();
  const [busy, setBusy] = useState(false);
  const act = async (action: () => Promise<unknown>) => { setBusy(true); try { await action(); } finally { setBusy(false); } };

  if (!online || !reachable) {
    return <div className="connectivity-banner" data-testid="offline-banner" role="status" aria-live="polite">
      <strong>Нет подключения</strong>
      <span>{pending ? `${changes(pending)} ${pluralRu(pending, 'сохранено', 'сохранены', 'сохранены')} на телефоне и ${pluralRu(pending, 'отправится само', 'отправятся сами', 'отправятся сами')}` : 'Показаны сохранённые данные. Работа по заказу сохранится на телефоне'}</span>
    </div>;
  }
  // A customer made offline whose phone is already on file: the same person, or someone else?
  const existing = failed?.errorCode === 'customer_phone_exists'
    ? (failed.errorDetails?.customers as Array<{ id: string; name: string; phoneDisplay: string }> | undefined)?.[0]
    : undefined;
  if (failed && existing) {
    return <div className="connectivity-banner sync-failed" data-testid="sync-duplicate-customer" role="alert">
      <strong>Такой телефон уже есть</strong>
      <span>Клиента <b>{failed.label.replace(/^Новый клиент · /, '')}</b> завели без сети, а на сервере с этим номером уже есть <b>{existing.name}</b> ({existing.phoneDisplay}).</span>
      <div className="sync-actions">
        <button disabled={busy} data-testid="sync-same-customer" onClick={() => act(() => linkFailedToExisting(existing.id))}>Это {existing.name}</button>
        <button disabled={busy} data-testid="sync-other-customer" onClick={() => act(confirmFailedDuplicate)}>Это другой человек</button>
      </div>
    </div>;
  }
  if (failed) {
    return <div className="connectivity-banner sync-failed" data-testid="sync-failed" role="alert">
      <strong>Не отправлено</strong>
      <span><b>{failed.label}</b>: {failed.error}</span>
      <div className="sync-actions">
        <button disabled={busy} onClick={() => act(retryFailed)}>Повторить</button>
        <button disabled={busy} data-testid="sync-discard" onClick={() => act(discardFailed)}>Отменить изменение</button>
      </div>
    </div>;
  }
  if (pending) {
    return <div className="connectivity-banner sync-pending" data-testid="sync-pending" role="status" aria-live="polite">
      <strong>{syncing ? 'Отправляем' : 'Ждёт отправки'}</strong><span>{changes(pending)}</span>
    </div>;
  }
  return null;
}
