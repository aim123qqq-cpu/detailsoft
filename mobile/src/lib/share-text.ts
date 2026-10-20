import type { WorkOrder } from '@df/types';
import { money } from './format';

const day = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * The work order as plain text for the share sheet (WhatsApp, Telegram, SMS…), as in the web app:
 * what was agreed and done, without phone numbers or payment data.
 */
export function orderShareText(order: WorkOrder, centerName: string, vehicleName: string, plate: string) {
  const approvedId = order.approval?.decision === 'APPROVED' ? order.approval.estimateVersionId : null;
  const estimate = order.estimateVersions.find((item) => item.id === (approvedId ?? order.currentEstimateVersionId));
  if (!estimate) return '';
  const works = order.work?.operations.length
    ? order.work.operations.filter((operation) => operation.status === 'DONE')
    : estimate.lines;
  return [
    `${centerName} — заказ-наряд`,
    [vehicleName, plate].filter(Boolean).join(', '),
    order.handover ? `Выдан: ${day.format(new Date(order.handover.handedOverAt))}` : null,
    '',
    'Выполненные работы:',
    ...works.map((work) => `• ${work.name} — ${money(work.amountMinor)}`),
    '',
    `Итого по согласованной смете v${estimate.version}: ${money(estimate.totalAmountMinor)}`,
    approvedId ? 'Смета согласована до начала работ.' : null,
    '',
    'Спасибо, что выбрали нас!'
  ].filter((line) => line !== null).join('\n');
}
