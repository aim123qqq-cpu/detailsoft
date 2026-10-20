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

/** "89131234567" → "+7 913 123-45-67" while typing, as in the web app. */
export function formatPhoneInput(value: string) {
  const digits = value.replace(/\D/g, '').replace(/^8/, '7').slice(0, 11);
  if (!digits) return '';
  const normalized = digits.startsWith('7') ? digits : `7${digits}`;
  const parts = [normalized.slice(1, 4), normalized.slice(4, 7), normalized.slice(7, 9), normalized.slice(9, 11)];
  let result = '+7';
  if (parts[0]) result += ` ${parts[0]}`;
  if (parts[1]) result += ` ${parts[1]}`;
  if (parts[2]) result += `-${parts[2]}`;
  if (parts[3]) result += `-${parts[3]}`;
  return result;
}

export function duration(minutes: number) {
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

export function visits(count: number) {
  if (!count) return 'новый клиент';
  const lastTwo = count % 100;
  const word = lastTwo >= 11 && lastTwo <= 14 ? 'визитов' : count % 10 === 1 ? 'визит' : count % 10 >= 2 && count % 10 <= 4 ? 'визита' : 'визитов';
  return `${count} ${word}`;
}

export const CHANNELS = [
  { code: 'call', label: 'Звонок' },
  { code: 'in_person', label: 'На месте' },
  { code: 'telegram', label: 'Telegram' },
  { code: 'vk', label: 'VK' },
  { code: 'instagram', label: 'Instagram' }
] as const;
export const channelLabel = (code: string) => CHANNELS.find((item) => item.code === code)?.label ?? code;

export const bookingStatuses: Record<string, { label: string; tone: 'neutral' | 'accent' | 'ok' | 'warn' }> = {
  DRAFT: { label: 'Черновик', tone: 'neutral' },
  CONFIRMED: { label: 'Подтверждена', tone: 'accent' },
  ARRIVED: { label: 'Клиент приехал', tone: 'ok' },
  CANCELLED: { label: 'Отменена', tone: 'neutral' },
  NO_SHOW: { label: 'Не приехал', tone: 'warn' }
};

// Dates of bookings are shown in the center's time zone (the phone may be set to another one).
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string, options: Intl.DateTimeFormatOptions, locale = 'ru-RU') {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  let value = formatters.get(key);
  if (!value) { value = new Intl.DateTimeFormat(locale, { ...options, timeZone }); formatters.set(key, value); }
  return value;
}

/** "2026-10-21" of a moment in the center's time zone. */
export const dayKey = (moment: Date | string, timeZone: string) =>
  formatter(timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA').format(new Date(moment));
export const timeOf = (iso: string, timeZone: string) => formatter(timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

/** Calendar arithmetic on day keys (noon UTC keeps it clear of time zone edges). */
export function addDays(key: string, amount: number) {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
const keyDate = (key: string) => new Date(`${key}T12:00:00Z`);
export const weekday = (key: string) => formatter('UTC', { weekday: 'short' }).format(keyDate(key)).replace('.', '');
export const dayOfMonth = (key: string) => keyDate(key).getUTCDate();
export const monthShort = (key: string) => formatter('UTC', { month: 'short' }).format(keyDate(key)).replace('.', '');
export const longDay = (key: string) => formatter('UTC', { day: 'numeric', month: 'long', weekday: 'long' }).format(keyDate(key));

/** "Сегодня", "Завтра" or "четверг, 23 октября". */
export function dayTitle(key: string, today: string) {
  if (key === today) return 'Сегодня';
  if (key === addDays(today, 1)) return 'Завтра';
  if (key === addDays(today, -1)) return 'Вчера';
  return longDay(key);
}
