// Shared by the server (server/domain/normalize.mjs re-exports it) and the app (offline search).

export function normalizePhone(value: unknown = '') {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`;
  return digits;
}

export function normalizePlate(value: unknown = '') {
  return String(value).normalize('NFC').replace(/[\s\-_.]/g, '').toLocaleUpperCase('ru-RU');
}

/** Shown wherever a plate goes when the car was added without one; such a car has an empty normalized plate. */
export const NO_PLATE = 'Без номера';

export function normalizeSearch(value: unknown = '') {
  return String(value).normalize('NFC').trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
}
