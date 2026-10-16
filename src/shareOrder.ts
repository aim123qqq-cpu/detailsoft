import type { WorkOrder } from './types';

type ShareVehicle = { make: string; model: string; generation?: string | null; plate: string };

const rub = (amountMinor: number) => `${Math.round(amountMinor / 100).toLocaleString('ru-RU').replace(/\s/g, ' ')} ₽`;
const dayFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

/** Works handed over to the client: approved estimate lines, as performed (or the estimate if no work run exists). */
function sharedEstimate(order: WorkOrder) {
  const approvedId = order.approval?.decision === 'APPROVED' ? order.approval.estimateVersionId : null;
  return order.estimateVersions.find((estimate) => estimate.id === (approvedId ?? order.currentEstimateVersionId)) ?? null;
}

export function canShareOrder(order: WorkOrder) {
  return order.status === 'CLOSED' && sharedEstimate(order) !== null;
}

/**
 * Plain-text summary for the system share sheet (WhatsApp, Telegram, SMS…).
 * It contains no phone numbers and no payment data — only what was agreed and done.
 */
export function formatOrderShareText({ centerName, order, vehicle }: { centerName: string; order: WorkOrder; vehicle: ShareVehicle }) {
  const estimate = sharedEstimate(order);
  if (!estimate) return '';
  const works = order.work?.operations.length
    ? order.work.operations.filter((operation) => operation.status === 'DONE').map((operation) => ({ name: operation.name, amountMinor: operation.amountMinor }))
    : estimate.lines.map((line) => ({ name: line.name, amountMinor: line.amountMinor }));
  const vehicleName = [vehicle.make, vehicle.model, vehicle.generation].filter(Boolean).join(' ');
  const handedOver = order.handover?.handedOverAt ? dayFormat.format(new Date(order.handover.handedOverAt)) : null;
  return [
    `${centerName} — заказ-наряд`,
    `${vehicleName}, ${vehicle.plate}`,
    handedOver ? `Выдан: ${handedOver}` : null,
    '',
    'Выполненные работы:',
    ...works.map((work) => `• ${work.name} — ${rub(work.amountMinor)}`),
    '',
    `Итого по согласованной смете v${estimate.version}: ${rub(estimate.totalAmountMinor)}`,
    order.approval?.decision === 'APPROVED' ? 'Смета согласована до начала работ.' : null,
    '',
    'Спасибо, что выбрали нас!'
  ].filter((line) => line !== null).join('\n');
}

export type ShareResult = 'shared' | 'cancelled' | 'copied' | 'manual';

/** System share sheet when available; otherwise clipboard; otherwise the caller shows the text for manual copy. */
export async function shareText({ title, text }: { title: string; text: string }): Promise<ShareResult> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, text });
      return 'shared';
    } catch (error) {
      if ((error as Error).name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'manual';
  }
}
