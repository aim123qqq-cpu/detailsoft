import { useEffect, useState } from 'react';
import { api } from '../api';
import { OrderFlow } from '../OrderFlow';
import type { Booking, OrderTarget } from '../types';

export function OrderWorkspaceLoader({ target, onPhaseChange, onBack }: { target: OrderTarget; onPhaseChange: (title: string) => void; onBack: () => void }) {
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api.getBooking(target.id, controller.signal)
      .then(setBooking)
      .catch((requestError: Error) => { if (requestError.name !== 'AbortError') setError(requestError.message); });
    return () => controller.abort();
  }, [target.id]);
  if (!booking) return <section className="screen">
    <button className="details-back" onClick={onBack}>← Назад</button>
    {error ? <div className="form-error" role="alert">{error}</div> : <div className="workspace-state"><span className="spinner"/> Открываем заказ</div>}
  </section>;
  return <OrderFlow booking={booking} customer={target.customer} vehicle={target.vehicle} orderId={target.orderId} onPhaseChange={onPhaseChange}/>;
}
