import { useEffect, useState } from 'react';
import type { BookingListItem, OrderTarget } from '../types';

// Helpers used by both the Bookings and the Orders workspaces.
export const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });

export function useWorkspaceItems<T>(load: (signal: AbortSignal) => Promise<{ items: T[] }>) {
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

export function LoadingState() {
  return <div className="workspace-state"><span className="spinner"/> Загружаем данные центра</div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="workspace-state error-state"><strong>Не удалось загрузить</strong><span>{message}</span><button onClick={onRetry}>Повторить</button></div>;
}

export function orderTarget(bookingId: string, orderId: string | null, item: Pick<BookingListItem, 'customer' | 'vehicle'>): OrderTarget {
  return {
    id: bookingId,
    orderId,
    customer: { id: item.customer.id, name: item.customer.name, phoneDisplay: item.customer.phoneDisplay, visitCount: 0, vehicles: [] },
    vehicle: { ...item.vehicle, status: 'active', active: true }
  };
}
