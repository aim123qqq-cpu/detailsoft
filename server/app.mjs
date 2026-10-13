import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { openDatabase } from './db.mjs';
import { DetailFlowRepository } from './repository.mjs';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('request_body_too_large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createDetailFlowServer({
  databasePath = './data/detailflow.db',
  seed = true,
  staticDir = null,
  authTokens = new Map([
    ['demo-session-token', 'tenant_demo'],
    ['other-session-token', 'tenant_other']
  ])
} = {}) {
  const db = openDatabase(databasePath, { seed });
  const repository = new DetailFlowRepository(db);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/health') return sendJson(response, 200, { status: 'ok' });

      if (url.pathname.startsWith('/api/')) {
        const authorization = request.headers.authorization;
        const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
          ? authorization.slice('Bearer '.length)
          : '';
        const tenantId = authTokens.get(token);
        if (!tenantId) {
          return sendJson(response, 401, { error: { code: 'unauthorized', message: 'Требуется авторизация' } });
        }

        if (request.method === 'GET' && url.pathname === '/api/customers') {
          return sendJson(response, 200, { items: repository.searchCustomers(tenantId, url.searchParams.get('phone') ?? '') });
        }
        if (request.method === 'POST' && url.pathname === '/api/customers') {
          const result = repository.createCustomer(tenantId, await readJson(request));
          if (result.kind === 'created') return sendJson(response, 201, result.customer);
          if (result.kind === 'tenant_not_found') return sendJson(response, 404, { error: { code: 'tenant_not_found', message: 'Центр не найден' } });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Укажите имя и корректный телефон' } });
        }
        const customerVehicles = url.pathname.match(/^\/api\/customers\/([^/]+)\/vehicles$/);
        if (request.method === 'GET' && customerVehicles) {
          const includeArchived = url.searchParams.get('includeArchived') === 'true';
          return sendJson(response, 200, { items: repository.listCustomerVehicles(tenantId, customerVehicles[1], includeArchived) });
        }
        if (request.method === 'GET' && url.pathname === '/api/vehicles') {
          return sendJson(response, 200, { items: repository.searchVehicles(tenantId, url.searchParams.get('plate') ?? '') });
        }
        if (request.method === 'GET' && url.pathname === '/api/vehicle-catalog/variants') {
          return sendJson(response, 200, { items: repository.searchCatalog(url.searchParams.get('q') ?? '') });
        }
        if (request.method === 'POST' && url.pathname === '/api/vehicles') {
          const result = repository.createVehicle(tenantId, await readJson(request));
          if (result.kind === 'created') return sendJson(response, 201, result);
          if (result.kind === 'duplicate') return sendJson(response, 409, {
            error: { code: 'possible_duplicate', message: 'Возможно, автомобиль уже существует', details: { matches: result.matches } }
          });
          if (result.kind === 'not_found') return sendJson(response, 404, { error: { code: `${result.resource}_not_found`, message: 'Связанная запись не найдена' } });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Проверьте госномер, цвет и модель' } });
        }
        const vehiclePatch = url.pathname.match(/^\/api\/vehicles\/([^/]+)$/);
        if (request.method === 'PATCH' && vehiclePatch) {
          const result = repository.updateVehicleStatus(tenantId, vehiclePatch[1], (await readJson(request)).status);
          if (result.kind === 'updated') return sendJson(response, 200, result.vehicle);
          if (result.kind === 'not_found') return sendJson(response, 404, { error: { code: 'vehicle_not_found', message: 'Автомобиль не найден' } });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Неизвестный статус' } });
        }
        if (request.method === 'GET' && url.pathname === '/api/tenants/current/services') {
          const result = repository.getServicesCatalog(tenantId, url.searchParams.get('vehicleId'));
          if (result.kind === 'found') return sendJson(response, 200, {
            vehicleClass: result.vehicleClass,
            categories: result.categories
          });
          return sendJson(response, 404, { error: { code: 'vehicle_not_found', message: 'Автомобиль не найден' } });
        }
        if (request.method === 'POST' && url.pathname === '/api/bookings/quote-preview') {
          const result = repository.previewBookingQuote(tenantId, await readJson(request));
          if (result.kind === 'quoted') return sendJson(response, 200, result.quote);
          if (result.kind === 'conflict') return sendJson(response, 409, {
            error: { code: result.code, message: result.message }
          });
          if (result.kind === 'not_found') return sendJson(response, 404, {
            error: { code: `${result.resource}_not_found`, message: 'Не удалось рассчитать выбранные услуги' }
          });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Выберите хотя бы одну услугу' } });
        }
        if (request.method === 'GET' && url.pathname === '/api/bookings/availability') {
          const duration = Number(url.searchParams.get('durationMinutes') ?? 60);
          const result = repository.getBookingAvailability(tenantId, url.searchParams.get('date') ?? '', duration);
          if (result.kind === 'available') return sendJson(response, 200, result);
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Проверьте дату и длительность' } });
        }
        if (request.method === 'POST' && url.pathname === '/api/bookings') {
          const idempotencyHeader = request.headers['idempotency-key'];
          const idempotencyKey = typeof idempotencyHeader === 'string' ? idempotencyHeader : '';
          const result = repository.createBooking(tenantId, await readJson(request), idempotencyKey);
          if (result.kind === 'created') return sendJson(response, 201, result.booking);
          if (result.kind === 'replayed') return sendJson(response, 200, result.booking);
          if (result.kind === 'idempotency_required') return sendJson(response, 400, {
            error: { code: 'idempotency_key_required', message: 'Повторите запрос с ключом идемпотентности' }
          });
          if (result.kind === 'conflict') return sendJson(response, 409, {
            error: { code: result.code, message: result.message }
          });
          if (result.kind === 'not_found') return sendJson(response, 404, {
            error: { code: `${result.resource}_not_found`, message: 'Клиент, автомобиль или услуга не найдены' }
          });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Проверьте дату, канал и услуги' } });
        }
        const bookingGet = url.pathname.match(/^\/api\/bookings\/([^/]+)$/);
        if (request.method === 'GET' && bookingGet && bookingGet[1] !== 'quote-preview') {
          const booking = repository.getBooking(tenantId, bookingGet[1]);
          return booking
            ? sendJson(response, 200, booking)
            : sendJson(response, 404, { error: { code: 'booking_not_found', message: 'Запись не найдена' } });
        }
        const orderGet = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
        if (request.method === 'GET' && orderGet) {
          const order = repository.getOrder(tenantId, orderGet[1]);
          return order ? sendJson(response, 200, order) : sendJson(response, 404, { error: { code: 'order_not_found', message: 'Заказ не найден' } });
        }
        return sendJson(response, 404, { error: { code: 'route_not_found', message: 'Маршрут не найден' } });
      }

      if (staticDir) {
        const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const safePath = requested.includes('..') ? 'index.html' : requested;
        try {
          const filePath = resolve(staticDir, safePath);
          const body = await readFile(filePath);
          response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream' });
          return response.end(body);
        } catch {
          const body = await readFile(resolve(staticDir, 'index.html'));
          response.writeHead(200, { 'content-type': contentTypes['.html'] });
          return response.end(body);
        }
      }
      response.writeHead(404).end();
    } catch (error) {
      if (error instanceof Error && error.message === 'request_body_too_large') {
        return sendJson(response, 413, { error: { code: 'request_body_too_large', message: 'Слишком большой запрос' } });
      }
      console.error(error);
      sendJson(response, 500, { error: { code: 'internal_error', message: 'Внутренняя ошибка' } });
    }
  });

  server.on('close', () => db.close());
  return server;
}
