import type { WorkOrder } from '@df/types';

export const money = (amountMinor: number) => `${Math.round(amountMinor / 100).toLocaleString('ru-RU').replace(/ | /g, ' ')} ₽`;

export const vehicleName = (vehicle: { make: string; model: string; generation?: string | null }) =>
  [vehicle.make, vehicle.model, vehicle.generation].filter(Boolean).join(' ');

export const orderStatuses: Record<WorkOrder['status'], { label: string; group: 'active' | 'ready' | 'closed' }> = {
  INTAKE: { label: 'Приёмка', group: 'active' },
  ESTIMATE_DRAFT: { label: 'Смета', group: 'active' },
  APPROVED: { label: 'Согласован', group: 'active' },
  IN_PROGRESS: { label: 'В работе', group: 'active' },
  QC: { label: 'Контроль качества', group: 'active' },
  READY: { label: 'Готов к выдаче', group: 'ready' },
  CLOSED: { label: 'Закрыт', group: 'closed' }
};

const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const shortDate = (iso: string) => dateFormat.format(new Date(iso));
