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

async function readJson(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('request_body_too_large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createDetailFlowServer({
  databasePath = './data/detailflow.db',
  seed = true,
  staticDir = null,
  features = { qualityControl: false },
  authTokens = new Map([
    ['demo-session-token', { tenantId: 'tenant_demo', displayName: 'Анна', roles: ['admin', 'intake', 'master', 'qc'] }],
    ['other-session-token', { tenantId: 'tenant_other', displayName: 'Администратор', roles: ['admin', 'intake', 'master', 'qc'] }]
  ])
} = {}) {
  const db = openDatabase(databasePath, { seed });
  const repository = new DetailFlowRepository(db);
  const qualityControlEnabled = features?.qualityControl === true;
  if (!qualityControlEnabled) repository.releaseDeprecatedQualityControlOrders();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/health') return sendJson(response, 200, { status: 'ok' });

      if (url.pathname.startsWith('/api/')) {
        const authorization = request.headers.authorization;
        const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
          ? authorization.slice('Bearer '.length)
          : '';
        const session = authTokens.get(token);
        const tenantId = typeof session === 'string' ? session : session?.tenantId;
        const roles = typeof session === 'string' ? ['admin', 'intake', 'master', 'qc'] : session?.roles ?? [];
        const hasRole = (...allowed) => allowed.some((role) => roles.includes(role));
        const capabilities = {
          manageCustomers: hasRole('admin'),
          manageBookings: hasRole('admin'),
          manageIntake: hasRole('admin', 'intake'),
          approveEstimates: hasRole('admin'),
          assignMasters: hasRole('admin'),
          performWork: hasRole('admin', 'master'),
          performQualityControl: qualityControlEnabled && hasRole('admin', 'qc'),
          closeOrders: hasRole('admin'),
          viewAnalytics: hasRole('admin', 'owner')
        };
        if (!tenantId) {
          return sendJson(response, 401, { error: { code: 'unauthorized', message: 'Требуется авторизация' } });
        }

        if (request.method === 'GET' && url.pathname === '/api/session') {
          const tenant = repository.getTenant(tenantId);
          if (!tenant) return sendJson(response, 404, {
            error: { code: 'tenant_not_found', message: 'Центр не найден' }
          });
          return sendJson(response, 200, {
            actor: {
              displayName: typeof session === 'string' ? 'Сотрудник' : session.displayName ?? 'Сотрудник',
              roles
            },
            tenant,
            preferences: { locale: 'ru-RU', currency: 'RUB' },
            features: { qualityControl: qualityControlEnabled },
            capabilities
          });
        }

        if (request.method === 'GET' && url.pathname === '/api/customers') {
          return sendJson(response, 200, { items: repository.searchCustomers(tenantId, url.searchParams.get('phone') ?? '') });
        }
        if (request.method === 'GET' && url.pathname === '/api/leads') {
          return sendJson(response, 200, { items: repository.listLeads(tenantId, url.searchParams.get('limit') ?? 50) });
        }
        if (request.method === 'POST' && url.pathname === '/api/leads') {
          if (!capabilities.manageBookings) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для создания обращения' }
          });
          const result = repository.createLead(tenantId, await readJson(request));
          if (result.kind === 'created') return sendJson(response, 201, result.lead);
          if (result.kind === 'not_found') return sendJson(response, 404, {
            error: { code: 'customer_not_found', message: 'Клиент не найден' }
          });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Укажите имя, телефон и канал обращения' } });
        }
        const leadPatch = url.pathname.match(/^\/api\/leads\/([^/]+)$/);
        if (request.method === 'PATCH' && leadPatch) {
          if (!capabilities.manageBookings) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для изменения обращения' }
          });
          const result = repository.updateLeadStatus(tenantId, leadPatch[1], (await readJson(request)).status);
          if (result.kind === 'updated') return sendJson(response, 200, result.lead);
          if (result.kind === 'not_found') return sendJson(response, 404, {
            error: { code: 'lead_not_found', message: 'Обращение не найдено' }
          });
          if (result.kind === 'conflict') return sendJson(response, 409, {
            error: { code: result.code, message: result.message }
          });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Неизвестный статус обращения' } });
        }
        if (request.method === 'POST' && url.pathname === '/api/customers') {
          if (!capabilities.manageCustomers) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для создания клиента' }
          });
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
          if (!capabilities.manageCustomers) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для добавления автомобиля' }
          });
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
          if (!capabilities.manageCustomers) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для изменения автомобиля' }
          });
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
        if (request.method === 'GET' && url.pathname === '/api/bookings') {
          return sendJson(response, 200, { items: repository.listBookings(tenantId, url.searchParams.get('limit') ?? 20) });
        }
        if (request.method === 'POST' && url.pathname === '/api/bookings') {
          if (!capabilities.manageBookings) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для создания записи' }
          });
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
        if (request.method === 'PATCH' && bookingGet) {
          if (!capabilities.manageBookings) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для изменения записи' }
          });
          const result = repository.updateBooking(tenantId, bookingGet[1], await readJson(request));
          if (result.kind === 'updated') return sendJson(response, 200, result.booking);
          if (result.kind === 'not_found') return sendJson(response, 404, {
            error: { code: 'booking_not_found', message: 'Запись не найдена' }
          });
          if (result.kind === 'conflict') return sendJson(response, 409, {
            error: { code: result.code, message: result.message }
          });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Проверьте изменение записи' } });
        }
        if (request.method === 'GET' && bookingGet && bookingGet[1] !== 'quote-preview') {
          const booking = repository.getBooking(tenantId, bookingGet[1]);
          return booking
            ? sendJson(response, 200, booking)
            : sendJson(response, 404, { error: { code: 'booking_not_found', message: 'Запись не найдена' } });
        }
        if (request.method === 'GET' && url.pathname === '/api/orders') {
          return sendJson(response, 200, { items: repository.listOrders(tenantId, url.searchParams.get('limit') ?? 20) });
        }
        if (request.method === 'GET' && url.pathname === '/api/analytics/overview') {
          if (!capabilities.viewAnalytics) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Аналитика доступна только руководителю' }
          });
          const from = url.searchParams.get('from') ?? '';
          const to = url.searchParams.get('to') ?? '';
          const datePattern = /^\d{4}-\d{2}-\d{2}$/;
          const fromTime = Date.parse(`${from}T00:00:00Z`);
          const toTime = Date.parse(`${to}T00:00:00Z`);
          const validDates = datePattern.test(from) && datePattern.test(to)
            && Number.isFinite(fromTime) && Number.isFinite(toTime)
            && new Date(fromTime).toISOString().slice(0, 10) === from
            && new Date(toTime).toISOString().slice(0, 10) === to;
          const periodDays = validDates ? Math.floor((toTime - fromTime) / 86_400_000) + 1 : 0;
          if (!validDates || periodDays < 1 || periodDays > 90) return sendJson(response, 422, {
            error: { code: 'validation_error', message: 'Выберите период от 1 до 90 дней' }
          });
          return sendJson(response, 200, repository.getAnalyticsOverview(tenantId, from, to));
        }
        if (request.method === 'POST' && url.pathname === '/api/orders') {
          if (!capabilities.manageIntake) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для начала приёмки' }
          });
          const result = repository.createOrderFromBooking(tenantId, await readJson(request));
          if (result.kind === 'created') return sendJson(response, 201, result.order);
          if (result.kind === 'replayed') return sendJson(response, 200, result.order);
          if (result.kind === 'not_found') return sendJson(response, 404, {
            error: { code: 'booking_not_found', message: 'Подтверждённая запись не найдена' }
          });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Укажите запись' } });
        }
        const orderIntake = url.pathname.match(/^\/api\/orders\/([^/]+)\/intake$/);
        if (request.method === 'PUT' && orderIntake) {
          if (!capabilities.manageIntake) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Приёмка доступна только администратору или приёмщику' }
          });
          const result = repository.saveOrderIntake(tenantId, orderIntake[1], await readJson(request));
          if (result.kind === 'updated') return sendJson(response, 200, result.order);
          if (result.kind === 'not_found') return sendJson(response, 404, {
            error: { code: 'order_not_found', message: 'Заказ не найден' }
          });
          if (result.kind === 'conflict') return sendJson(response, 409, {
            error: { code: result.code, message: result.message }
          });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Проверьте данные приёмки' } });
        }
        const orderPhotos = url.pathname.match(/^\/api\/orders\/([^/]+)\/photos$/);
        if (request.method === 'POST' && orderPhotos) {
          const photoInput = await readJson(request, 1024 * 1024);
          const canUpload = photoInput.phase === 'result' ? capabilities.closeOrders : capabilities.manageIntake;
          if (!canUpload) return sendJson(response, 403, {
            error: { code: 'forbidden', message: photoInput.phase === 'result'
              ? 'Фото результата доступно только администратору'
              : 'Фото приёмки доступны только администратору или приёмщику' }
          });
          const result = repository.addOrderPhoto(tenantId, orderPhotos[1], photoInput);
          if (result.kind === 'created') return sendJson(response, 201, result.photo);
          if (result.kind === 'not_found') return sendJson(response, 404, {
            error: { code: 'order_not_found', message: 'Заказ не найден' }
          });
          if (result.kind === 'conflict') return sendJson(response, 409, {
            error: { code: result.code, message: result.message }
          });
          return sendJson(response, 422, {
            error: { code: 'validation_error', message: 'Выберите JPG, PNG или WebP до 700 КБ' }
          });
        }
        const orderEstimates = url.pathname.match(/^\/api\/orders\/([^/]+)\/estimates$/);
        if (request.method === 'POST' && orderEstimates) {
          if (!capabilities.manageIntake) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Черновик сметы доступен только администратору или приёмщику' }
          });
          const result = repository.createEstimateVersion(tenantId, orderEstimates[1], await readJson(request));
          if (result.kind === 'created') return sendJson(response, 201, result.estimate);
          if (result.kind === 'not_found') return sendJson(response, 404, {
            error: { code: 'order_not_found', message: 'Заказ не найден' }
          });
          if (result.kind === 'conflict') return sendJson(response, 409, {
            error: { code: result.code, message: result.message }
          });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Добавьте корректные строки сметы' } });
        }
        const estimateApprovals = url.pathname.match(/^\/api\/orders\/([^/]+)\/estimate-approvals$/);
        if (request.method === 'POST' && estimateApprovals) {
          if (!capabilities.approveEstimates) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для согласования сметы' }
          });
          const result = repository.decideEstimate(tenantId, estimateApprovals[1], await readJson(request));
          if (result.kind === 'updated') return sendJson(response, 200, result.order);
          if (result.kind === 'not_found') return sendJson(response, 404, {
            error: { code: 'order_not_found', message: 'Заказ не найден' }
          });
          if (result.kind === 'conflict') return sendJson(response, 409, {
            error: { code: result.code, message: result.message }
          });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Укажите решение и источник согласования' } });
        }
        const orderAssignment = url.pathname.match(/^\/api\/orders\/([^/]+)\/assignment$/);
        if (request.method === 'PUT' && orderAssignment) {
          if (!capabilities.assignMasters) return sendJson(response, 403, { error: { code: 'forbidden', message: 'Недостаточно прав для назначения мастера' } });
          const result = repository.assignOrderMaster(tenantId, orderAssignment[1], await readJson(request));
          if (result.kind === 'updated') return sendJson(response, 200, result.order);
          if (result.kind === 'not_found') return sendJson(response, 404, { error: { code: 'order_not_found', message: 'Заказ не найден' } });
          if (result.kind === 'conflict') return sendJson(response, 409, { error: { code: result.code, message: result.message } });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Укажите мастера' } });
        }
        const workStart = url.pathname.match(/^\/api\/orders\/([^/]+)\/work\/start$/);
        if (request.method === 'POST' && workStart) {
          if (!capabilities.performWork) return sendJson(response, 403, { error: { code: 'forbidden', message: 'Доступно только мастеру' } });
          const result = repository.startOrderWork(tenantId, workStart[1]);
          if (result.kind === 'updated') return sendJson(response, 200, result.order);
          if (result.kind === 'not_found') return sendJson(response, 404, { error: { code: 'order_not_found', message: 'Заказ не найден' } });
          return sendJson(response, 409, { error: { code: result.code, message: result.message } });
        }
        const workOperation = url.pathname.match(/^\/api\/orders\/([^/]+)\/work\/operations\/([^/]+)$/);
        if (request.method === 'PATCH' && workOperation) {
          if (!capabilities.performWork) return sendJson(response, 403, { error: { code: 'forbidden', message: 'Доступно только мастеру' } });
          const result = repository.updateWorkOperation(tenantId, workOperation[1], workOperation[2], await readJson(request));
          if (result.kind === 'updated') return sendJson(response, 200, result.order);
          if (result.kind === 'not_found') return sendJson(response, 404, { error: { code: 'operation_not_found', message: 'Операция не найдена' } });
          if (result.kind === 'conflict') return sendJson(response, 409, { error: { code: result.code, message: result.message } });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Проверьте статус операции' } });
        }
        const workPause = url.pathname.match(/^\/api\/orders\/([^/]+)\/work\/(pause|resume)$/);
        if (request.method === 'POST' && workPause) {
          if (!capabilities.performWork) return sendJson(response, 403, { error: { code: 'forbidden', message: 'Доступно только мастеру' } });
          const result = repository.setWorkPause(tenantId, workPause[1], workPause[2] === 'pause', await readJson(request));
          if (result.kind === 'updated') return sendJson(response, 200, result.order);
          if (result.kind === 'not_found') return sendJson(response, 404, { error: { code: 'order_not_found', message: 'Заказ не найден' } });
          if (result.kind === 'conflict') return sendJson(response, 409, { error: { code: result.code, message: result.message } });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Укажите причину паузы' } });
        }
        const workComplete = url.pathname.match(/^\/api\/orders\/([^/]+)\/work\/complete$/);
        if (request.method === 'POST' && workComplete) {
          if (!capabilities.performWork) return sendJson(response, 403, { error: { code: 'forbidden', message: 'Доступно только мастеру' } });
          const result = repository.completeOrderWork(tenantId, workComplete[1], { qualityControlEnabled });
          if (result.kind === 'updated') return sendJson(response, 200, result.order);
          if (result.kind === 'not_found') return sendJson(response, 404, { error: { code: 'order_not_found', message: 'Заказ не найден' } });
          return sendJson(response, 409, { error: { code: result.code, message: result.message } });
        }
        const orderQc = url.pathname.match(/^\/api\/orders\/([^/]+)\/qc$/);
        if (request.method === 'POST' && orderQc) {
          if (!qualityControlEnabled) return sendJson(response, 410, {
            error: { code: 'feature_deprecated', message: 'Этап контроля качества временно отключён' }
          });
          if (!capabilities.performQualityControl) return sendJson(response, 403, { error: { code: 'forbidden', message: 'Доступно только контролю качества' } });
          const result = repository.submitQualityControl(tenantId, orderQc[1], await readJson(request));
          if (result.kind === 'updated') return sendJson(response, 200, result.order);
          if (result.kind === 'not_found') return sendJson(response, 404, { error: { code: 'order_not_found', message: 'Заказ не найден' } });
          if (result.kind === 'conflict') return sendJson(response, 409, { error: { code: result.code, message: result.message } });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Заполните результат контроля качества' } });
        }
        const orderHandover = url.pathname.match(/^\/api\/orders\/([^/]+)\/handover$/);
        if (request.method === 'POST' && orderHandover) {
          if (!capabilities.closeOrders) return sendJson(response, 403, { error: { code: 'forbidden', message: 'Недостаточно прав для выдачи автомобиля' } });
          const result = repository.closeOrderHandover(tenantId, orderHandover[1], await readJson(request));
          if (result.kind === 'updated') return sendJson(response, 200, result.order);
          if (result.kind === 'not_found') return sendJson(response, 404, { error: { code: 'order_not_found', message: 'Заказ не найден' } });
          if (result.kind === 'conflict') return sendJson(response, 409, { error: { code: result.code, message: result.message } });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Подтвердите осмотр, комплектность и данные выдачи' } });
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
