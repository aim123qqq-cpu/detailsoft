import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { openDatabase } from './db.mjs';
import { DetailFlowRepository } from './repository.mjs';
import { AuthRepository, MESSENGER_PROVIDERS } from './auth-repository.mjs';
import { createBotDialog } from './messenger/bot-dialog.mjs';
import { PERMISSIONS } from './roles-repository.mjs';
import { createIdempotency } from './idempotency.mjs';
import { buildBookingPack } from './offline-pack.mjs';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg'
};

function sendJson(response, status, payload) {
  // API data must never come from an HTTP cache: the app keeps its own offline copy.
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid_json');
  }
}

// Small in-memory limiter for public sign-in endpoints (per client address).
function createRateLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((time) => now - time < windowMs);
    recent.push(now);
    hits.set(key, recent);
    return recent.length <= limit;
  };
}

export function createDetailFlowServer({
  databasePath = './data/detailflow.db',
  seed = true,
  staticDir = null,
  features = { qualityControl: false },
  authTokens = new Map([
    ['demo-session-token', { tenantId: 'tenant_demo', displayName: 'Анна', roles: ['owner', 'admin', 'intake', 'master', 'qc'] }],
    ['other-session-token', { tenantId: 'tenant_other', displayName: 'Администратор', roles: ['admin', 'intake', 'master', 'qc'] }]
  ]),
  messengers = []
} = {}) {
  const db = openDatabase(databasePath, { seed });
  const repository = new DetailFlowRepository(db);
  const auth = new AuthRepository(db);
  const adapters = new Map(messengers.map((adapter) => [adapter.provider, adapter]));
  const readyProviders = new Set();
  const botDialog = createBotDialog({ auth, adapters });
  const allowLoginRequest = createRateLimiter(20, 60_000);
  const idempotency = createIdempotency(db);
  for (const adapter of adapters.values()) {
    adapter.start(botDialog)
      .then(() => readyProviders.add(adapter.provider))
      .catch((error) => console.error(`${adapter.provider} bot is unavailable:`, error.message));
  }
  const qualityControlEnabled = features?.qualityControl === true;
  if (!qualityControlEnabled) repository.releaseDeprecatedQualityControlOrders();

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/health') return sendJson(response, 200, { status: 'ok' });
      if (url.pathname === '/api/ready') {
        // Readiness for a load balancer or monitor: the database answers; bots are reported, not required.
        const messengerStatus = Object.fromEntries([...adapters.keys()].map((provider) => [
          provider, readyProviders.has(provider) ? 'ready' : 'unavailable'
        ]));
        try {
          db.prepare('SELECT 1').get();
        } catch {
          return sendJson(response, 503, { status: 'unavailable', database: 'error', messengers: messengerStatus });
        }
        return sendJson(response, 200, { status: 'ready', database: 'ok', messengers: messengerStatus });
      }

      // Public sign-in endpoints: the browser has no session yet.
      if (url.pathname === '/api/auth/providers' && request.method === 'GET') {
        return sendJson(response, 200, {
          items: [...readyProviders].map((provider) => ({
            provider, title: adapters.get(provider).title, botName: adapters.get(provider).botName
          })),
          demo: authTokens.has('demo-session-token')
        });
      }
      if (url.pathname === '/api/auth/login-requests' && request.method === 'POST') {
        if (!allowLoginRequest(request.socket.remoteAddress ?? 'unknown')) return sendJson(response, 429, {
          error: { code: 'too_many_requests', message: 'Слишком много попыток входа. Подождите минуту' }
        });
        const provider = (await readJson(request)).provider;
        if (!MESSENGER_PROVIDERS.includes(provider) || !readyProviders.has(provider)) return sendJson(response, 422, {
          error: { code: 'provider_unavailable', message: 'Вход через этот мессенджер не настроен' }
        });
        const login = auth.createLoginRequest(provider);
        const adapter = adapters.get(provider);
        return sendJson(response, 201, {
          id: login.id, provider, shortCode: login.shortCode, pollSecret: login.pollSecret, expiresAt: login.expiresAt,
          botName: adapter.botName, deepLink: adapter.deepLink(`login_${login.startToken}`)
        });
      }
      const loginRequest = url.pathname.match(/^\/api\/auth\/login-requests\/([^/]+)(\/session)?$/);
      if (loginRequest) {
        const pollSecret = request.headers['x-login-secret'];
        if (request.method === 'GET' && !loginRequest[2]) {
          const status = auth.getLoginStatus(loginRequest[1], pollSecret);
          return status ? sendJson(response, 200, status) : sendJson(response, 404, { error: { code: 'login_not_found', message: 'Запрос входа не найден' } });
        }
        if (request.method === 'POST' && loginRequest[2]) {
          const input = await readJson(request);
          const result = auth.createSessionFromLogin(loginRequest[1], pollSecret, typeof input.tenantId === 'string' ? input.tenantId : null);
          if (result.kind === 'created') return sendJson(response, 201, result.session);
          if (result.kind === 'choose_tenant') return sendJson(response, 409, {
            error: { code: 'choose_tenant', message: 'Выберите центр', details: { memberships: result.memberships } }
          });
          if (result.kind === 'conflict') return sendJson(response, 409, { error: { code: result.code, message: result.message } });
          return sendJson(response, 404, { error: { code: 'login_not_found', message: 'Запрос входа не найден' } });
        }
      }

      if (url.pathname.startsWith('/api/')) {
        const authorization = request.headers.authorization;
        const token = typeof authorization === 'string' && authorization.startsWith('Bearer ')
          ? authorization.slice('Bearer '.length)
          : '';
        const session = authTokens.get(token) ?? auth.authenticateSession(token) ?? repository.authenticateTeamToken(token);
        const tenantId = typeof session === 'string' ? session : session?.tenantId;
        const roles = typeof session === 'string' ? ['admin', 'intake', 'master', 'qc'] : session?.roles ?? [];
        const hasRole = (...allowed) => allowed.some((role) => roles.includes(role));
        const actorName = typeof session === 'string' ? 'Сотрудник' : session?.displayName ?? 'Сотрудник';
        // Permissions come from the center's roles (system roles with the owner's edits, plus custom roles).
        const granted = tenantId ? repository.roles.permissionsFor(tenantId, roles) : new Set();
        const can = (permission) => granted.has(permission);
        const capabilities = {
          manageCustomers: can('manageCustomers'),
          manageBookings: can('manageBookings'),
          manageIntake: can('manageIntake'),
          approveEstimates: can('approveEstimates'),
          assignMasters: can('assignMasters'),
          performWork: can('performWork'),
          acceptAssignments: can('acceptAssignments'),
          performQualityControl: qualityControlEnabled && hasRole('admin', 'qc'),
          closeOrders: can('closeOrders'),
          manageCatalog: can('manageCatalog'),
          manageSettings: can('manageSettings'),
          manageTeam: can('manageTeam'),
          viewAnalytics: can('viewAnalytics')
        };
        if (!tenantId) {
          return sendJson(response, 401, { error: { code: 'unauthorized', message: 'Требуется авторизация' } });
        }

        // Read access by role. Phones, plates and leads are personal data for the front desk only;
        // orders and a single booking (no phone) stay readable for every role so masters can work.
        const isGet = request.method === 'GET';
        const readAllowed =
          isGet && ['/api/customers', '/api/vehicles', '/api/vehicle-catalog/variants'].includes(url.pathname) ? capabilities.manageCustomers
          : isGet && /^\/api\/customers\/[^/]+\/vehicles$/.test(url.pathname) ? capabilities.manageCustomers
          : isGet && url.pathname === '/api/leads' ? capabilities.manageBookings
          : isGet && url.pathname === '/api/bookings' ? capabilities.manageBookings || capabilities.manageIntake
          : isGet && ['/api/bookings/availability', '/api/tenants/current/services'].includes(url.pathname) ? capabilities.manageBookings
          : request.method === 'POST' && url.pathname === '/api/bookings/quote-preview' ? capabilities.manageBookings
          : true;
        if (!readAllowed) return sendJson(response, 403, { error: { code: 'forbidden', message: 'Раздел недоступен для вашей роли' } });

        // A retried change (offline queue, lost answer) gets the stored answer instead of running twice.
        // Booking creation keeps its own key handling.
        const idempotencyKey = request.headers['idempotency-key'];
        if (request.method !== 'GET' && typeof idempotencyKey === 'string' && idempotencyKey &&
          !(request.method === 'POST' && url.pathname === '/api/bookings')) {
          if (await idempotency({ request, response, tenantId, key: idempotencyKey, pathname: url.pathname }) !== 'proceed') return;
        }

        if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
          return sendJson(response, 200, { revoked: auth.revokeSession(token) });
        }
        if (request.method === 'GET' && url.pathname === '/api/session') {
          const tenant = repository.getTenant(tenantId);
          if (!tenant) return sendJson(response, 404, {
            error: { code: 'tenant_not_found', message: 'Центр не найден' }
          });
          return sendJson(response, 200, {
            actor: {
              displayName: typeof session === 'string' ? 'Сотрудник' : session.displayName ?? 'Сотрудник',
              roles,
              roleNames: repository.roles.listRoles(tenantId).filter((role) => roles.includes(role.key)).map((role) => role.name),
              memberId: session?.memberId ?? null,
              authMethod: authTokens.has(token) ? 'demo' : token.startsWith('dfs_') ? 'messenger' : 'access_token'
            },
            tenant,
            preferences: { locale: 'ru-RU', currency: 'RUB' },
            features: { qualityControl: qualityControlEnabled },
            capabilities
          });
        }

        if (request.method === 'GET' && url.pathname === '/api/customers') {
          return sendJson(response, 200, { items: repository.searchCustomers(
            tenantId, url.searchParams.get('phone') ?? '', url.searchParams.get('includeArchived') === 'true'
          ) });
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
          if (result.kind === 'conflict') return sendJson(response, 409, { error: { code: result.code, message: result.message, details: result.details ?? {} } });
          if (result.kind === 'tenant_not_found') return sendJson(response, 404, { error: { code: 'tenant_not_found', message: 'Центр не найден' } });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Укажите имя и корректный телефон' } });
        }
        const customerProfile = url.pathname.match(/^\/api\/customers\/([^/]+)\/profile$/);
        if (request.method === 'GET' && customerProfile) {
          if (!capabilities.manageCustomers) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для просмотра карточки клиента' }
          });
          const profile = repository.getCustomerProfile(tenantId, customerProfile[1]);
          return profile
            ? sendJson(response, 200, profile)
            : sendJson(response, 404, { error: { code: 'customer_not_found', message: 'Клиент не найден' } });
        }
        const customerPatch = url.pathname.match(/^\/api\/customers\/([^/]+)$/);
        if (request.method === 'PATCH' && customerPatch) {
          if (!capabilities.manageCustomers) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для изменения клиента' }
          });
          const result = repository.updateCustomer(tenantId, customerPatch[1], await readJson(request), actorName);
          if (result.kind === 'updated') return sendJson(response, 200, result.profile);
          if (result.kind === 'not_found') return sendJson(response, 404, { error: { code: 'customer_not_found', message: 'Клиент не найден' } });
          if (result.kind === 'archived') return sendJson(response, 409, {
            error: { code: 'customer_archived', message: 'Клиент в архиве. Верните его, чтобы изменить контакты' }
          });
          if (result.kind === 'duplicate') return sendJson(response, 409, {
            error: { code: 'possible_duplicate', message: 'Этот телефон уже указан у другого клиента', details: { matches: result.matches } }
          });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Укажите имя от 2 до 120 символов и корректный телефон' } });
        }
        const customerArchive = url.pathname.match(/^\/api\/customers\/([^/]+)\/(archive|reactivate)$/);
        if (request.method === 'POST' && customerArchive) {
          if (!capabilities.manageCustomers) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для архивации клиента' }
          });
          const result = customerArchive[2] === 'archive'
            ? repository.archiveCustomer(tenantId, customerArchive[1], actorName)
            : repository.reactivateCustomer(tenantId, customerArchive[1], actorName);
          if (result.kind === 'updated') return sendJson(response, 200, result.profile);
          if (result.kind === 'active_work') return sendJson(response, 409, {
            error: {
              code: 'customer_has_active_work',
              message: 'У клиента есть активные записи, заказы или обращения. Завершите или отмените их перед архивацией',
              details: result.details
            }
          });
          return sendJson(response, 404, { error: { code: 'customer_not_found', message: 'Клиент не найден' } });
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
        if (request.method === 'GET' && url.pathname === '/api/tenants/current/vehicle-classes') {
          if (!capabilities.manageCustomers) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для просмотра классов автомобиля' }
          });
          return sendJson(response, 200, { items: repository.listVehicleClasses(tenantId) });
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
        const vehicleProfile = url.pathname.match(/^\/api\/vehicles\/([^/]+)\/profile$/);
        if (request.method === 'GET' && vehicleProfile) {
          if (!capabilities.manageCustomers) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для просмотра карточки автомобиля' }
          });
          const profile = repository.getVehicleProfile(tenantId, vehicleProfile[1]);
          return profile
            ? sendJson(response, 200, profile)
            : sendJson(response, 404, { error: { code: 'vehicle_not_found', message: 'Автомобиль не найден' } });
        }
        const vehicleTransfer = url.pathname.match(/^\/api\/vehicles\/([^/]+)\/transfer$/);
        if (request.method === 'POST' && vehicleTransfer) {
          if (!capabilities.manageCustomers) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для смены владельца' }
          });
          const result = repository.transferVehicleOwner(tenantId, vehicleTransfer[1], (await readJson(request)).customerId);
          if (result.kind === 'transferred') return sendJson(response, 200, result.profile);
          if (result.kind === 'same_owner') return sendJson(response, 409, {
            error: { code: 'same_owner', message: 'Этот клиент уже указан владельцем' }
          });
          if (result.kind === 'invalid') return sendJson(response, 422, {
            error: { code: 'validation_error', message: 'Выберите нового владельца' }
          });
          return sendJson(response, 404, {
            error: { code: `${result.resource}_not_found`, message: 'Автомобиль или клиент не найден' }
          });
        }
        const vehiclePatch = url.pathname.match(/^\/api\/vehicles\/([^/]+)$/);
        if (request.method === 'PATCH' && vehiclePatch) {
          if (!capabilities.manageCustomers) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для изменения автомобиля' }
          });
          const input = await readJson(request);
          const detailKeys = ['bodyType', 'tenantClass'];
          const hasDetails = detailKeys.some((key) => Object.hasOwn(input, key));
          if (hasDetails && Object.hasOwn(input, 'status')) return sendJson(response, 422, {
            error: { code: 'validation_error', message: 'Изменяйте статус и параметры автомобиля отдельными действиями' }
          });
          const detailResult = hasDetails
            ? repository.updateVehicleDetails(tenantId, vehiclePatch[1], input)
            : null;
          if (detailResult?.kind === 'updated' && !Object.hasOwn(input, 'status')) return sendJson(response, 200, detailResult.vehicle);
          if (detailResult?.kind === 'not_found') return sendJson(response, 404, { error: { code: 'vehicle_not_found', message: 'Автомобиль не найден' } });
          if (detailResult?.kind === 'invalid') return sendJson(response, 422, { error: { code: 'validation_error', message: 'Проверьте кузов и класс автомобиля' } });
          const result = Object.hasOwn(input, 'status')
            ? repository.updateVehicleStatus(tenantId, vehiclePatch[1], input.status)
            : { kind: 'invalid' };
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
        if (request.method === 'GET' && url.pathname === '/api/tenants/current/catalog') {
          if (!capabilities.manageCatalog) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Каталог доступен владельцу или администратору' }
          });
          return sendJson(response, 200, repository.getManagedCatalog(tenantId));
        }
        if (request.method === 'POST' && url.pathname === '/api/tenants/current/catalog/operations') {
          if (!capabilities.manageCatalog) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для изменения каталога' }
          });
          const result = repository.createCatalogOperation(tenantId, await readJson(request));
          if (result.kind === 'created') return sendJson(response, 201, result.operation);
          if (result.kind === 'duplicate') return sendJson(response, 409, {
            error: { code: 'operation_exists', message: 'Операция с таким названием уже существует' }
          });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Проверьте название операции' } });
        }
        const managedCatalogCreate = url.pathname.match(/^\/api\/tenants\/current\/catalog\/(services|packages)$/);
        if (request.method === 'POST' && managedCatalogCreate) {
          if (!capabilities.manageCatalog) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для изменения каталога' }
          });
          const type = managedCatalogCreate[1] === 'services' ? 'service' : 'package';
          const result = repository.createManagedCatalogItem(tenantId, type, await readJson(request));
          if (result.kind === 'created') return sendJson(response, 201, result.item);
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Проверьте позицию, операции и стартовые цены' } });
        }
        const managedCatalogItem = url.pathname.match(/^\/api\/tenants\/current\/catalog\/(services|packages)\/([^/]+)$/);
        if (request.method === 'PATCH' && managedCatalogItem) {
          if (!capabilities.manageCatalog) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для изменения каталога' }
          });
          const type = managedCatalogItem[1] === 'services' ? 'service' : 'package';
          const result = repository.updateManagedCatalogItem(tenantId, type, managedCatalogItem[2], await readJson(request));
          if (result.kind === 'updated') return sendJson(response, 200, result.item);
          if (result.kind === 'not_found') return sendJson(response, 404, {
            error: { code: 'catalog_item_not_found', message: 'Позиция каталога не найдена' }
          });
          if (result.kind === 'conflict') return sendJson(response, 409, { error: { code: result.code, message: result.message } });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Проверьте данные и цены каталога' } });
        }
        if (url.pathname.startsWith('/api/tenants/current/catalog/sections') || url.pathname.startsWith('/api/tenants/current/catalog/simple-services')) {
          if (!capabilities.manageCatalog) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для изменения каталога' }
          });
          const catalog = repository.catalog;
          const sendCatalogResult = (result, status = 200) => {
            if (result.kind === 'created' || result.kind === 'updated') return sendJson(response, status, result.section ?? result.item ?? { items: result.sections });
            if (result.kind === 'deleted') return sendJson(response, 200, { deleted: true });
            if (result.kind === 'not_found') return sendJson(response, 404, { error: { code: 'catalog_item_not_found', message: 'Раздел или услуга не найдены' } });
            if (result.kind === 'conflict') return sendJson(response, 409, { error: { code: result.code, message: result.message } });
            if (result.code === 'section_required') return sendJson(response, 422, { error: { code: 'section_required', message: 'Выберите раздел' } });
            return sendJson(response, 422, { error: { code: 'validation_error', message: 'Проверьте название, время и цену' } });
          };
          if (request.method === 'GET' && url.pathname === '/api/tenants/current/catalog/sections') {
            return sendJson(response, 200, { items: catalog.listSections(tenantId) });
          }
          if (request.method === 'POST' && url.pathname === '/api/tenants/current/catalog/sections') {
            return sendCatalogResult(catalog.createSection(tenantId, await readJson(request)), 201);
          }
          if (request.method === 'PUT' && url.pathname === '/api/tenants/current/catalog/sections/order') {
            return sendCatalogResult(catalog.reorderSections(tenantId, await readJson(request)));
          }
          const sectionMatch = url.pathname.match(/^\/api\/tenants\/current\/catalog\/sections\/([^/]+)$/);
          if (sectionMatch && request.method === 'PATCH') return sendCatalogResult(catalog.renameSection(tenantId, sectionMatch[1], await readJson(request)));
          if (sectionMatch && request.method === 'DELETE') return sendCatalogResult(catalog.deleteSection(tenantId, sectionMatch[1]));
          if (request.method === 'POST' && url.pathname === '/api/tenants/current/catalog/simple-services') {
            return sendCatalogResult(catalog.createSimpleService(tenantId, await readJson(request)), 201);
          }
          const simpleMatch = url.pathname.match(/^\/api\/tenants\/current\/catalog\/simple-services\/([^/]+)$/);
          if (simpleMatch && request.method === 'PUT') return sendCatalogResult(catalog.updateSimpleService(tenantId, simpleMatch[1], await readJson(request)));
        }
        if (request.method === 'GET' && url.pathname === '/api/tenants/current/catalog/operations') {
          if (!capabilities.manageCatalog) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Каталог доступен владельцу или администратору' }
          });
          return sendJson(response, 200, { items: repository.listOperationLibrary(tenantId, url.searchParams.get('q') ?? '') });
        }
        const catalogOperation = url.pathname.match(/^\/api\/tenants\/current\/catalog\/operations\/([^/]+)$/);
        if (request.method === 'PATCH' && catalogOperation) {
          if (!capabilities.manageCatalog) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для изменения каталога' }
          });
          const result = repository.updateCatalogOperation(tenantId, catalogOperation[1], await readJson(request));
          if (result.kind === 'updated') return sendJson(response, 200, result.operation);
          if (result.kind === 'not_found') return sendJson(response, 404, { error: { code: 'operation_not_found', message: 'Операция не найдена' } });
          if (result.kind === 'duplicate') return sendJson(response, 409, { error: { code: 'operation_exists', message: 'Операция с таким названием уже существует' } });
          if (result.kind === 'conflict') return sendJson(response, 409, { error: { code: result.code, message: result.message, details: result.details } });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Укажите название от 2 до 120 символов или статус' } });
        }
        if (request.method === 'GET' && url.pathname === '/api/tenants/current/settings') {
          if (!capabilities.manageSettings) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Настройки доступны владельцу или администратору' }
          });
          const settings = repository.getCenterSettings(tenantId);
          return settings
            ? sendJson(response, 200, settings)
            : sendJson(response, 404, { error: { code: 'tenant_not_found', message: 'Центр не найден' } });
        }
        if (request.method === 'PATCH' && url.pathname === '/api/tenants/current/settings') {
          if (!capabilities.manageSettings) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для изменения настроек' }
          });
          const result = repository.updateCenterSettings(tenantId, await readJson(request));
          if (result.kind === 'updated') return sendJson(response, 200, result.settings);
          if (result.kind === 'not_found') return sendJson(response, 404, {
            error: { code: 'tenant_not_found', message: 'Центр не найден' }
          });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Проверьте график и вместимость центра' } });
        }
        if (request.method === 'GET' && url.pathname === '/api/tenants/current/team') {
          if (!capabilities.manageTeam) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Команда доступна только владельцу центра' }
          });
          const links = auth.listMessengerLinks(tenantId);
          return sendJson(response, 200, { items: repository.listTeamMembers(tenantId).map((member) => ({
            ...member, messengerLinks: links.filter((link) => link.memberId === member.id)
          })) });
        }
        if (url.pathname === '/api/tenants/current/roles' || url.pathname.startsWith('/api/tenants/current/roles/')) {
          if (!capabilities.manageTeam) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Роли настраивает только владелец центра' }
          });
          const sendRoleResult = (result, status = 200) => {
            if (result.kind === 'created' || result.kind === 'updated') return sendJson(response, status, result.role);
            if (result.kind === 'not_found') return sendJson(response, 404, { error: { code: 'role_not_found', message: 'Роль не найдена' } });
            if (result.kind === 'conflict') return sendJson(response, 409, { error: { code: result.code, message: result.message } });
            return sendJson(response, 422, { error: { code: 'validation_error', message: 'Укажите название (2–40 символов) и хотя бы одно право' } });
          };
          if (request.method === 'GET' && url.pathname === '/api/tenants/current/roles') {
            return sendJson(response, 200, {
              permissions: PERMISSIONS,
              items: repository.roles.listRoles(tenantId, { includeArchived: url.searchParams.get('includeArchived') === 'true' })
            });
          }
          if (request.method === 'POST' && url.pathname === '/api/tenants/current/roles') {
            return sendRoleResult(repository.roles.createRole(tenantId, await readJson(request), actorName), 201);
          }
          const roleMatch = url.pathname.match(/^\/api\/tenants\/current\/roles\/([^/]+)(?:\/(archive|restore|events))?$/);
          if (roleMatch && request.method === 'PATCH' && !roleMatch[2]) {
            return sendRoleResult(repository.roles.updateRole(tenantId, roleMatch[1], await readJson(request), actorName));
          }
          if (roleMatch && request.method === 'POST' && (roleMatch[2] === 'archive' || roleMatch[2] === 'restore')) {
            return sendRoleResult(repository.roles.setRoleArchived(tenantId, roleMatch[1], roleMatch[2] === 'archive', actorName));
          }
          if (roleMatch && request.method === 'GET' && roleMatch[2] === 'events') {
            return sendJson(response, 200, { items: repository.roles.listRoleEvents(tenantId, roleMatch[1]) });
          }
        }
        if (request.method === 'GET' && url.pathname === '/api/tenants/current/masters') {
          if (!capabilities.assignMasters) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Список мастеров доступен тому, кто назначает работы' }
          });
          return sendJson(response, 200, { items: repository.listMasters(tenantId) });
        }
        const teamInvite = url.pathname.match(/^\/api\/tenants\/current\/team\/([^/]+)\/messenger-invites$/);
        if (request.method === 'POST' && teamInvite) {
          if (!capabilities.manageTeam) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Приглашать сотрудников может только владелец центра' }
          });
          const provider = (await readJson(request)).provider;
          const result = auth.createInvite(tenantId, teamInvite[1], provider);
          if (result.kind === 'created') {
            const adapter = readyProviders.has(provider) ? adapters.get(provider) : null;
            return sendJson(response, 201, {
              ...result.invite, botName: adapter?.botName ?? null, deepLink: adapter ? adapter.deepLink(result.invite.code) : null
            });
          }
          if (result.kind === 'not_found') return sendJson(response, 404, { error: { code: 'member_not_found', message: 'Сотрудник не найден' } });
          if (result.kind === 'conflict') return sendJson(response, 409, { error: { code: result.code, message: result.message } });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Выберите Telegram или MAX' } });
        }
        const teamLink = url.pathname.match(/^\/api\/tenants\/current\/team\/([^/]+)\/messenger-links\/([^/]+)$/);
        if (request.method === 'DELETE' && teamLink) {
          if (!capabilities.manageTeam) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Отвязывать мессенджер может только владелец центра' }
          });
          return auth.removeMessengerLink(tenantId, teamLink[1], teamLink[2])
            ? sendJson(response, 200, { removed: true })
            : sendJson(response, 404, { error: { code: 'link_not_found', message: 'Привязка не найдена' } });
        }
        if (request.method === 'POST' && url.pathname === '/api/tenants/current/team') {
          if (!capabilities.manageTeam) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Добавлять сотрудников может только владелец центра' }
          });
          const result = repository.createTeamMember(tenantId, await readJson(request));
          if (result.kind === 'created') return sendJson(response, 201, {
            member: result.member, accessToken: result.accessToken
          });
          return sendJson(response, 422, {
            error: { code: 'validation_error', message: 'Укажите имя и хотя бы одну доступную роль' }
          });
        }
        const teamMemberPatch = url.pathname.match(/^\/api\/tenants\/current\/team\/([^/]+)$/);
        if (request.method === 'PATCH' && teamMemberPatch) {
          if (!capabilities.manageTeam) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Изменять команду может только владелец центра' }
          });
          const result = repository.updateTeamMember(tenantId, teamMemberPatch[1], await readJson(request));
          if (result.kind === 'updated') return sendJson(response, 200, result.member);
          if (result.kind === 'not_found') return sendJson(response, 404, {
            error: { code: 'team_member_not_found', message: 'Сотрудник не найден' }
          });
          if (result.kind === 'conflict') return sendJson(response, 409, {
            error: { code: 'last_owner_required', message: 'В центре должен остаться хотя бы один активный владелец' }
          });
          return sendJson(response, 422, {
            error: { code: 'validation_error', message: 'Проверьте роли и статус сотрудника' }
          });
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
          const result = repository.getBookingAvailability(tenantId, url.searchParams.get('date') ?? '', duration, url.searchParams.get('excludeBookingId'));
          if (result.kind === 'available') return sendJson(response, 200, result);
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Проверьте дату и длительность' } });
        }
        if (request.method === 'GET' && url.pathname === '/api/bookings') {
          const result = repository.listBookings(
            tenantId,
            url.searchParams.get('limit') ?? 20,
            url.searchParams.has('from') ? url.searchParams.get('from') : null,
            url.searchParams.has('to') ? url.searchParams.get('to') : null,
            url.searchParams.has('view') ? url.searchParams.get('view') : null
          );
          if (result.kind === 'listed') return sendJson(response, 200, { items: result.items });
          return sendJson(response, 422, {
            error: { code: 'validation_error', message: 'Диапазон календаря должен быть не больше 31 дня' }
          });
        }
        if (request.method === 'GET' && url.pathname === '/api/offline/booking-pack') {
          if (!capabilities.manageBookings) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Записи без сети доступны тем, кто ведёт записи' }
          });
          return sendJson(response, 200, buildBookingPack(repository, tenantId, { includeCustomers: capabilities.manageCustomers }));
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
        const bookingQuote = url.pathname.match(/^\/api\/bookings\/([^/]+)\/quote$/);
        if (request.method === 'PUT' && bookingQuote) {
          if (!capabilities.manageBookings) return sendJson(response, 403, {
            error: { code: 'forbidden', message: 'Недостаточно прав для изменения записи' }
          });
          const result = repository.reviseBookingQuote(tenantId, bookingQuote[1], await readJson(request), actorName);
          if (result.kind === 'updated') return sendJson(response, 200, result.booking);
          if (result.kind === 'conflict') return sendJson(response, 409, { error: { code: result.code, message: result.message } });
          if (result.kind === 'not_found') return sendJson(response, 404, {
            error: { code: `${result.resource}_not_found`, message: result.resource === 'booking' ? 'Запись не найдена' : 'Не удалось рассчитать выбранные услуги' }
          });
          return sendJson(response, 422, { error: { code: 'validation_error', message: 'Выберите услуги и укажите текущую версию расчёта' } });
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
          if (result.kind === 'conflict') return sendJson(response, 409, { error: { code: result.code, message: result.message } });
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
          if (result.code === 'not_a_master') return sendJson(response, 422, {
            error: { code: 'not_a_master', message: 'Выберите активного сотрудника с правом «Исполнитель заказов»' }
          });
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
        const orderDocuments = url.pathname.match(/^\/api\/orders\/([^/]+)\/documents(?:\/([^/]+))?$/);
        if (orderDocuments) {
          const [, documentOrderId, documentPath] = orderDocuments;
          const canReadDocuments = capabilities.manageIntake || capabilities.closeOrders;
          const documentNotFound = { error: { code: 'order_not_found', message: 'Заказ не найден' } };
          if (request.method === 'GET' && documentPath === 'preview') {
            if (!canReadDocuments) return sendJson(response, 403, { error: { code: 'forbidden', message: 'Недостаточно прав для документов заказа' } });
            const type = url.searchParams.get('type');
            if (!['intake_act', 'handover_act'].includes(type)) return sendJson(response, 422, { error: { code: 'validation_error', message: 'Неизвестный тип документа' } });
            const result = repository.buildOrderDocumentContent(tenantId, documentOrderId, type);
            if (result.kind === 'built') return sendJson(response, 200, { type, content: result.content });
            if (result.kind === 'conflict') return sendJson(response, 409, { error: { code: result.code, message: result.message } });
            return sendJson(response, 404, documentNotFound);
          }
          if (request.method === 'GET' && !documentPath) {
            if (!canReadDocuments) return sendJson(response, 403, { error: { code: 'forbidden', message: 'Недостаточно прав для документов заказа' } });
            const items = repository.listOrderDocuments(tenantId, documentOrderId);
            return items ? sendJson(response, 200, { items }) : sendJson(response, 404, documentNotFound);
          }
          if (request.method === 'GET' && documentPath) {
            if (!canReadDocuments) return sendJson(response, 403, { error: { code: 'forbidden', message: 'Недостаточно прав для документов заказа' } });
            const document = repository.getOrderDocument(tenantId, documentOrderId, documentPath);
            return document ? sendJson(response, 200, document) : sendJson(response, 404, { error: { code: 'document_not_found', message: 'Документ не найден' } });
          }
          if (request.method === 'POST' && !documentPath) {
            const input = await readJson(request, 512 * 1024);
            const allowed = input?.type === 'handover_act' ? capabilities.closeOrders : input?.type === 'intake_act' ? capabilities.manageIntake : canReadDocuments;
            if (!allowed) return sendJson(response, 403, { error: { code: 'forbidden', message: 'Недостаточно прав для этого документа' } });
            const result = repository.issueOrderDocument(tenantId, documentOrderId, input, actorName);
            if (result.kind === 'created') return sendJson(response, 201, result.document);
            if (result.kind === 'conflict') return sendJson(response, 409, { error: { code: result.code, message: result.message } });
            if (result.kind === 'not_found') return sendJson(response, 404, documentNotFound);
            return sendJson(response, 422, { error: { code: 'validation_error', message: 'Проверьте тип документа, ФИО и подпись (PNG до 200 КБ)' } });
          }
        }
        const orderGet = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
        if (request.method === 'GET' && orderGet) {
          const order = repository.getOrder(tenantId, orderGet[1]);
          return order ? sendJson(response, 200, order) : sendJson(response, 404, { error: { code: 'order_not_found', message: 'Заказ не найден' } });
        }
        return sendJson(response, 404, { error: { code: 'route_not_found', message: 'Маршрут не найден' } });
      }

      if (staticDir) {
        // The landing page (public/landing) lives next to the app; its relative assets need the trailing slash.
        if (url.pathname === '/landing') {
          response.writeHead(301, { location: '/landing/' });
          return response.end();
        }
        const requested = url.pathname === '/' ? 'index.html' : url.pathname.endsWith('/') ? `${url.pathname.slice(1)}index.html` : url.pathname.slice(1);
        const safePath = requested.includes('..') ? 'index.html' : requested;
        try {
          const filePath = resolve(staticDir, safePath);
          const body = await readFile(filePath);
          // Hashed build assets never change; index.html is revalidated but kept for offline start.
          response.writeHead(200, {
            'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
            'cache-control': safePath.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
          });
          return response.end(body);
        } catch {
          const body = await readFile(resolve(staticDir, 'index.html'));
          response.writeHead(200, { 'content-type': contentTypes['.html'], 'cache-control': 'no-cache' });
          return response.end(body);
        }
      }
      response.writeHead(404).end();
    } catch (error) {
      if (error instanceof Error && error.message === 'request_body_too_large') {
        return sendJson(response, 413, { error: { code: 'request_body_too_large', message: 'Слишком большой запрос' } });
      }
      if (error instanceof Error && error.message === 'invalid_json') {
        return sendJson(response, 400, { error: { code: 'invalid_json', message: 'Тело запроса должно быть корректным JSON' } });
      }
      console.error(error);
      sendJson(response, 500, { error: { code: 'internal_error', message: 'Внутренняя ошибка' } });
    }
  });

  server.on('close', () => {
    for (const adapter of adapters.values()) adapter.stop();
    db.close();
  });
  return server;
}
