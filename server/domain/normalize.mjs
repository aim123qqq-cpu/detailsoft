export function normalizePhone(value = '') {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`;
  return digits;
}

export function normalizePlate(value = '') {
  return String(value).normalize('NFC').replace(/[\s\-_.]/g, '').toLocaleUpperCase('ru-RU');
}

export function normalizeSearch(value = '') {
  return String(value).normalize('NFC').trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
}
