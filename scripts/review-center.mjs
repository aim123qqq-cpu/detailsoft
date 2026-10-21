// A center for store reviewers (RuStore, Google Play): an owner with an access code and sample data, so a
// reviewer signs in without a messenger and sees a working app. Run on the server while DetailFlow runs:
//   sudo -u detailflow node scripts/review-center.mjs            create it (once) and print the access code
//   sudo -u detailflow node scripts/review-center.mjs --new-code a new access code for the existing center
// The access code is printed once; it is the reviewer's password, keep it out of git.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { openDatabase } from '../server/db.mjs';
import { DetailFlowRepository } from '../server/repository.mjs';

const NAME = 'Тестовый центр для проверки';
const OWNER = 'Проверяющий магазина';
const base = `http://127.0.0.1:${process.env.PORT ?? 4173}`;
const db = openDatabase(process.env.DATABASE_PATH ?? resolve('data/detailflow.db'), { seed: false });
const repository = new DetailFlowRepository(db);

const existing = db.prepare('SELECT id FROM tenants WHERE name = ?').get(NAME);
if (existing && !process.argv.includes('--new-code')) {
  console.log(`«${NAME}» already exists (${existing.id}). For a new access code: --new-code`);
  process.exit(0);
}
const tenantId = existing?.id ?? `tenant_${randomUUID()}`;
if (!existing) db.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').run(tenantId, NAME);
const created = repository.createTeamMember(tenantId, { displayName: OWNER, roles: ['owner', 'admin'] });
if (created.kind !== 'created') throw new Error(`Could not create the owner: ${created.kind}`);
const token = created.accessToken;
db.close();

if (!existing) {
  let key = 0;
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `review-${Date.now()}-${key++}` },
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${payload.error?.message ?? ''}`);
    return payload;
  };

  const section = await api('/api/tenants/current/catalog/sections', 'POST', { name: 'Мойка и уход' });
  const services = [];
  for (const [name, rubles, minutes] of [['Бережная мойка', 1500, 40], ['Химчистка салона', 6500, 180], ['Защитное покрытие кузова', 9000, 120]]) {
    services.push(await api('/api/tenants/current/catalog/simple-services', 'POST', {
      sectionId: section.id, name, description: '', pricingMode: 'fixed', basePrice: { amountMinor: rubles * 100, durationMinutes: minutes }, classPrices: []
    }));
  }

  const people = [];
  for (const [name, phone, query, plate, color] of [
    ['Алексей Морозов', '+7 913 100-20-30', 'Camry', 'А100АА 55', 'чёрный'],
    ['Мария Ковалёва', '+7 913 400-50-60', 'Mazda 3', 'В200ВВ 55', 'белый']
  ]) {
    const customer = await api('/api/customers', 'POST', { name, phone });
    const [variant] = (await api(`/api/vehicle-catalog/variants?q=${encodeURIComponent(query)}`)).items;
    const { vehicle } = await api('/api/vehicles', 'POST', variant
      ? { customerId: customer.id, catalogVariantId: variant.id, plateDisplay: plate, color }
      : { customerId: customer.id, manual: { make: query.split(' ')[0], model: query.split(' ')[1] ?? query, bodyType: 'sedan' }, plateDisplay: plate, color });
    people.push({ customer, vehicle });
  }

  // A booking tomorrow and an order already at intake today.
  const book = async (person, date, serviceIds) => {
    const quote = await api('/api/bookings/quote-preview', 'POST', { vehicleId: person.vehicle.id, selections: serviceIds.map((id) => ({ type: 'service', id })) });
    const slots = (await api(`/api/bookings/availability?date=${date}&durationMinutes=${quote.totalDurationMinutes}`)).slots.filter((slot) => slot.available);
    if (!slots.length) return null;
    return api('/api/bookings', 'POST', { customerId: person.customer.id, vehicleId: person.vehicle.id, channel: 'call', startAt: slots[Math.min(4, slots.length - 1)].startAt,
      selections: serviceIds.map((id) => ({ type: 'service', id })) });
  };
  const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  await book(people[1], day(1), [services[1].id]);
  const today = await book(people[0], day(1), [services[0].id, services[2].id]);
  if (today) {
    const order = await api('/api/orders', 'POST', { bookingId: today.id });
    await api(`/api/orders/${order.id}/intake`, 'PUT', {
      bodyType: 'sedan', conditionSummary: 'Автомобиль принят при клиенте, комплектность проверена',
      findings: [{ zone: 'Капот', severity: 'MEDIUM', note: 'Скол ЛКП' }, { zone: 'Переднее левое колесо', severity: 'LOW', note: 'Бордюрная царапина' }],
      recommendations: [{ title: 'Локальная защита скола', reason: 'Снизит риск коррозии', priority: 'RECOMMENDED' }]
    });
  }
}

console.log(`«${NAME}» (${tenantId})`);
console.log(`Access code for the reviewer: ${token}`);
