import { useState } from 'react';
import { api } from './api';
import { canShareOrder, formatOrderShareText, shareText, type ShareResult } from './shareOrder';
import type { WorkOrder } from './types';

export function ShareOrderButton({ order, vehicle }: {
  order: WorkOrder;
  vehicle: { make: string; model: string; generation?: string | null; plate: string };
}) {
  const [state, setState] = useState<'idle' | 'busy' | ShareResult>('idle');
  const [text, setText] = useState('');
  if (!canShareOrder(order)) return null;

  const share = async () => {
    setState('busy');
    let centerName = 'Детейлинг-центр';
    try { centerName = (await api.getSession()).tenant.name; } catch { /* the text is still useful without the center name */ }
    const body = formatOrderShareText({ centerName, order, vehicle });
    setText(body);
    setState(await shareText({ title: 'Заказ-наряд', text: body }));
  };

  return <div className="share-order" data-testid="share-order">
    <button className="primary-button share-order-button" data-testid="share-order-button" disabled={state === 'busy'} onClick={share}>
      Поделиться сметой
    </button>
    <small>Откроется меню «Поделиться» телефона: WhatsApp, Telegram, SMS и другие приложения.</small>
    {state === 'copied' && <p className="share-order-note" role="status" data-testid="share-order-copied">Текст скопирован — вставьте его в чат с клиентом.</p>}
    {state === 'manual' && <div className="share-order-manual" data-testid="share-order-manual">
      <p>Меню «Поделиться» недоступно в этом браузере (нужен HTTPS). Выделите текст и скопируйте его:</p>
      <textarea readOnly value={text} rows={Math.min(14, text.split('\n').length + 1)} aria-label="Текст для отправки клиенту" onFocus={(event) => event.target.select()} data-testid="share-order-text"/>
      <button type="button" onClick={() => setState('idle')}>Готово</button>
    </div>}
  </div>;
}
