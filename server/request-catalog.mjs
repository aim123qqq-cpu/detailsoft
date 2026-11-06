// What each request to the server means in words: for the journal and the request breakdown in /admin.
// A route missing here still works; it is shown as «Другой запрос к API» until someone names it.

export const REQUEST_GROUPS = {
  work: 'Работа в центрах',
  signin: 'Вход и регистрация',
  site: 'Сайт и файлы',
  admin: 'Сама админка',
  service: 'Служебные проверки',
  unknown: 'Чужие и неизвестные'
};

// [method, path, group, label, meaning for a change]. Changes go to the journal one by one; views once in a while.
const ROUTES = [
  ['GET', '/api/session', 'work', 'Открытие приложения'],
  ['GET', '/api/me', 'work', 'Профиль сотрудника'],
  ['DELETE', '/api/me', 'work', 'Удаление своего аккаунта', 'Сотрудник удалил аккаунт в «Профиле». Имя в документах центра заменено на «Удалённый сотрудник».'],
  ['POST', '/api/legal/accept', 'work', 'Принятие соглашения', 'Сотрудник принял соглашение и дал согласие на обработку данных.'],
  ['POST', '/api/auth/logout', 'work', 'Выход из аккаунта', 'Сотрудник вышел из аккаунта на этом устройстве.'],

  ['GET', '/api/bookings', 'work', 'Список записей'],
  ['POST', '/api/bookings', 'work', 'Создание записи', 'Новая запись клиента в расписании центра.'],
  ['GET', '/api/bookings/availability', 'work', 'Подбор свободного времени'],
  ['POST', '/api/bookings/quote-preview', 'work', 'Расчёт стоимости записи'],
  ['GET', '/api/bookings/:id', 'work', 'Карточка записи'],
  ['PATCH', '/api/bookings/:id', 'work', 'Изменение записи', 'Запись перенесли, отменили или отметили приезд клиента.'],
  ['PUT', '/api/bookings/:id/quote', 'work', 'Изменение услуг в записи', 'В записи поменяли состав услуг или сумму.'],

  ['GET', '/api/orders', 'work', 'Список заказов'],
  ['POST', '/api/orders', 'work', 'Создание заказа', 'Автомобиль принят в работу: появился заказ.'],
  ['GET', '/api/orders/:id', 'work', 'Карточка заказа'],
  ['PUT', '/api/orders/:id/intake', 'work', 'Приёмка автомобиля', 'Сохранена приёмка: схема кузова и замечания.'],
  ['GET', '/api/orders/:id/photos', 'work', 'Фото заказа'],
  ['POST', '/api/orders/:id/photos', 'work', 'Загрузка фото', 'К заказу добавлено фото автомобиля.'],
  ['POST', '/api/orders/:id/estimates', 'work', 'Составление сметы', 'Сохранена новая версия сметы.'],
  ['POST', '/api/orders/:id/estimate-approvals', 'work', 'Согласование сметы', 'Смету согласовали с клиентом.'],
  ['PUT', '/api/orders/:id/assignment', 'work', 'Назначение мастера', 'Заказ назначен мастеру.'],
  ['POST', '/api/orders/:id/work/start', 'work', 'Начало работ', 'Мастер начал работы по заказу.'],
  ['PATCH', '/api/orders/:id/work/operations/:id', 'work', 'Отметка операции', 'Мастер отметил операцию в заказе.'],
  ['POST', '/api/orders/:id/work/pause', 'work', 'Пауза в работах', 'Мастер приостановил работы.'],
  ['POST', '/api/orders/:id/work/resume', 'work', 'Продолжение работ', 'Мастер продолжил работы.'],
  ['POST', '/api/orders/:id/work/complete', 'work', 'Завершение работ', 'Работы по заказу закончены.'],
  ['POST', '/api/orders/:id/qc', 'work', 'Контроль качества', 'Результат проверки качества.'],
  ['POST', '/api/orders/:id/handover', 'work', 'Выдача автомобиля', 'Автомобиль выдан клиенту, заказ закрыт. Это главный признак реальной работы центра.'],
  ['GET', '/api/orders/:id/documents', 'work', 'Акты заказа'],
  ['GET', '/api/orders/:id/documents/:id', 'work', 'Просмотр акта'],
  ['POST', '/api/orders/:id/documents', 'work', 'Выпуск акта', 'Выпущен акт приёмки или выдачи.'],

  ['GET', '/api/customers', 'work', 'Поиск клиентов'],
  ['POST', '/api/customers', 'work', 'Новый клиент', 'В базу центра добавлен клиент.'],
  ['PATCH', '/api/customers/:id', 'work', 'Изменение клиента', 'Изменены данные клиента.'],
  ['GET', '/api/customers/:id/profile', 'work', 'Карточка клиента'],
  ['GET', '/api/customers/:id/vehicles', 'work', 'Автомобили клиента'],
  ['POST', '/api/customers/:id/vehicles', 'work', 'Привязка автомобиля', 'Клиенту добавлен автомобиль.'],
  ['POST', '/api/customers/:id/erase', 'work', 'Удаление данных клиента', 'Данные клиента обезличены по его запросу.'],
  ['POST', '/api/customers/:id/archive', 'work', 'Клиент в архиве', 'Клиент убран в архив.'],
  ['POST', '/api/customers/:id/reactivate', 'work', 'Клиент из архива', 'Клиент возвращён из архива.'],
  ['GET', '/api/vehicles', 'work', 'Поиск автомобилей'],
  ['POST', '/api/vehicles', 'work', 'Новый автомобиль', 'В базу центра добавлен автомобиль.'],
  ['PATCH', '/api/vehicles/:id', 'work', 'Изменение автомобиля', 'Изменены данные автомобиля.'],
  ['GET', '/api/vehicles/:id/profile', 'work', 'Карточка автомобиля'],
  ['POST', '/api/vehicles/:id/transfer', 'work', 'Смена владельца автомобиля', 'Автомобиль передан другому клиенту.'],
  ['GET', '/api/vehicle-catalog/variants', 'work', 'Справочник автомобилей'],
  ['GET', '/api/leads', 'work', 'Список обращений'],
  ['POST', '/api/leads', 'work', 'Новое обращение', 'Записано обращение клиента.'],
  ['PATCH', '/api/leads/:id', 'work', 'Обработка обращения', 'Обращение клиента обработано.'],
  ['GET', '/api/analytics/overview', 'work', 'Статистика центра'],
  ['GET', '/api/offline/booking-pack', 'work', 'Данные для работы без сети'],

  ['GET', '/api/notifications', 'work', 'Лента уведомлений'],
  ['POST', '/api/notifications/read', 'work', 'Уведомления прочитаны', 'Сотрудник отметил уведомления прочитанными.'],
  ['POST', '/api/notifications/surveys/:id/answer', 'work', 'Ответ на опрос', 'Сотрудник ответил на опрос из «Рассылок».'],
  ['GET', '/api/notifications/preferences', 'work', 'Настройки уведомлений'],
  ['PUT', '/api/notifications/preferences', 'work', 'Изменение настроек уведомлений', 'Сотрудник изменил, какие уведомления получать.'],
  ['GET', '/api/notifications/push-key', 'work', 'Подготовка push-уведомлений'],
  ['POST', '/api/notifications/push', 'work', 'Включение push-уведомлений', 'На устройстве включены уведомления.'],
  ['POST', '/api/notifications/push/remove', 'work', 'Отключение push-уведомлений', 'На устройстве отключены уведомления.'],

  ['GET', '/api/tenants/current/setup', 'work', 'Первые шаги центра'],
  ['GET', '/api/tenants/current/settings', 'work', 'Настройки центра'],
  ['PATCH', '/api/tenants/current/settings', 'work', 'Изменение настроек центра', 'Изменены график или вместимость центра.'],
  ['GET', '/api/tenants/current/requisites', 'work', 'Реквизиты центра'],
  ['PUT', '/api/tenants/current/requisites', 'work', 'Изменение реквизитов', 'Изменены реквизиты центра для актов.'],
  ['GET', '/api/tenants/current/reminders', 'work', 'Настройки напоминаний'],
  ['PUT', '/api/tenants/current/reminders', 'work', 'Изменение напоминаний', 'Изменены напоминания о записях.'],
  ['GET', '/api/tenants/current/vehicle-classes', 'work', 'Классы автомобилей'],
  ['GET', '/api/tenants/current/services', 'work', 'Список услуг'],
  ['GET', '/api/tenants/current/catalog', 'work', 'Каталог услуг'],
  ['POST', '/api/tenants/current/catalog/operations', 'work', 'Новая операция', 'В каталог добавлена операция.'],
  ['PATCH', '/api/tenants/current/catalog/operations/:id', 'work', 'Изменение операции', 'Изменена операция каталога.'],
  ['POST', '/api/tenants/current/catalog/services', 'work', 'Новая услуга', 'В каталог добавлена услуга.'],
  ['PATCH', '/api/tenants/current/catalog/services/:id', 'work', 'Изменение услуги', 'Изменена услуга каталога.'],
  ['POST', '/api/tenants/current/catalog/packages', 'work', 'Новый пакет услуг', 'В каталог добавлен пакет.'],
  ['PATCH', '/api/tenants/current/catalog/packages/:id', 'work', 'Изменение пакета услуг', 'Изменён пакет услуг.'],
  ['POST', '/api/tenants/current/catalog/sections', 'work', 'Новый раздел каталога', 'В каталог добавлен раздел.'],
  ['PUT', '/api/tenants/current/catalog/sections/order', 'work', 'Порядок разделов каталога', 'Изменён порядок разделов.'],
  ['PATCH', '/api/tenants/current/catalog/sections/:id', 'work', 'Переименование раздела', 'Раздел каталога переименован.'],
  ['DELETE', '/api/tenants/current/catalog/sections/:id', 'work', 'Удаление раздела', 'Раздел каталога удалён.'],
  ['POST', '/api/tenants/current/catalog/simple-services', 'work', 'Новая услуга', 'В каталог добавлена услуга.'],
  ['PUT', '/api/tenants/current/catalog/simple-services/:id', 'work', 'Изменение услуги', 'Изменена услуга каталога.'],
  ['DELETE', '/api/tenants/current/catalog/simple-services/:id', 'work', 'Удаление услуги', 'Услуга убрана из каталога.'],
  ['GET', '/api/tenants/current/masters', 'work', 'Список мастеров'],
  ['GET', '/api/tenants/current/team', 'work', 'Команда центра'],
  ['POST', '/api/tenants/current/team', 'work', 'Новый сотрудник', 'В команду центра добавлен сотрудник.'],
  ['PATCH', '/api/tenants/current/team/:id', 'work', 'Изменение сотрудника', 'Изменены роли или статус сотрудника.'],
  ['PUT', '/api/tenants/current/team/:id/email', 'work', 'Email сотрудника для входа', 'Сотруднику указан email для входа.'],
  ['POST', '/api/tenants/current/team/:id/messenger-invites', 'work', 'Приглашение сотрудника', 'Создано приглашение привязать мессенджер.'],
  ['DELETE', '/api/tenants/current/team/:id/messenger-links/:id', 'work', 'Отвязка мессенджера', 'Сотрудник больше не сможет входить через этот мессенджер.'],
  ['GET', '/api/tenants/current/roles', 'work', 'Роли центра'],
  ['POST', '/api/tenants/current/roles', 'work', 'Новая роль', 'В центре создана своя роль.'],
  ['PATCH', '/api/tenants/current/roles/:id', 'work', 'Изменение роли', 'Изменены права роли.'],
  ['POST', '/api/tenants/current/roles/:id/archive', 'work', 'Роль в архиве', 'Роль убрана в архив.'],
  ['POST', '/api/tenants/current/roles/:id/restore', 'work', 'Роль из архива', 'Роль возвращена из архива.'],
  ['GET', '/api/tenants/current/roles/:id/events', 'work', 'История роли'],

  ['GET', '/api/auth/providers', 'signin', 'Экран входа: способы входа'],
  ['POST', '/api/auth/login-requests', 'signin', 'Начало входа через мессенджер'],
  ['GET', '/api/auth/login-requests/:id', 'signin', 'Экран входа ждёт подтверждения'],
  ['POST', '/api/auth/login-requests/:id/session', 'signin', 'Открытие рабочего места после входа'],
  ['POST', '/api/auth/login-requests/:id/center', 'signin', 'Создание центра'],
  ['POST', '/api/auth/email-requests', 'signin', 'Письмо с кодом входа'],
  ['POST', '/api/auth/email-requests/:id/confirm', 'signin', 'Проверка кода из письма'],

  ['GET', '/api/admin/stats', 'admin', 'Обзор и статистика'],
  ['GET', '/api/admin/events', 'admin', 'Журнал обновляется'],
  ['POST', '/api/admin/logout', 'admin', 'Выход из админки', 'Владелец сервиса вышел из админки.'],
  ['POST', '/api/admin/login-requests/:id/session', 'admin', 'Вход в админку', 'Владелец сервиса вошёл в админку.'],
  ['PATCH', '/api/admin/centers/:id', 'admin', 'Учёт центра в статистике', 'Центр включён в статистику или убран из неё.'],
  ['GET', '/api/admin/broadcasts', 'admin', 'Список рассылок'],
  ['POST', '/api/admin/broadcasts', 'admin', 'Отправка рассылки', 'Владелец сервиса отправил рассылку людям центров.'],
  ['POST', '/api/admin/broadcasts/preview', 'admin', 'Проверка рассылки'],
  ['GET', '/api/admin/broadcasts/:id', 'admin', 'Результаты рассылки'],

  ['GET', '/api/health', 'service', 'Проверка, что сервер жив'],
  ['GET', '/api/ready', 'service', 'Проверка готовности и версии']
].map(([method, path, group, label, meaning]) => ({
  method, path, group, label, meaning: meaning ?? '',
  pattern: new RegExp(`^${path.replace(/:id/g, '([^/]+)')}$`)
}));

// Addresses nobody of ours asks for: robots looking for holes in any site on the internet.
const PROBE = /\.(php|env|git|asp|aspx|jsp|cgi|sql|bak|ini|yml|yaml|xml)\b|\/wp-|\/\.|\/(phpmyadmin|cgi-bin|vendor|boaform|actuator)\b/i;

const CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Changes of a person's own account: push switched on at start, a feed marked read. They happen without any work.
const NOT_WORK = /^\/api\/(auth|legal|me|notifications)(\/|$)/;

/** 'app', 'site', or null for anything else (robots, scripts). A browser always says Mozilla; the app sends its own name. */
export function clientOf(userAgent) {
  const value = String(userAgent ?? '');
  if (value.startsWith('Mozilla/')) return 'site';
  return /detailflow|okhttp|dalvik|cfnetwork/i.test(value) ? 'app' : null;
}
const LABELS = new Map(ROUTES.map((route) => [`${route.method} ${route.path}`, route]));
const FILES = { 'site:pages': 'Страницы сайта', 'site:files': 'Файлы сайта (картинки, скрипты, шрифты)', 'site:admin': 'Страница админки',
  'unknown:api': 'Другой запрос к API', 'unknown:probe': 'Роботы ищут уязвимости', 'unknown:missing': 'Несуществующие адреса' };

/** The key a request is counted under. It never holds an id, so the list of kinds stays short. */
export function classifyRequest(method, path, status = 200) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (match) {
      const change = CHANGING.has(method);
      // Counting a price sends a POST too, but changes nothing: only what has a meaning is an action in a center.
      const work = change && route.group === 'work' && Boolean(route.meaning) && !NOT_WORK.test(route.path);
      return { key: `${method} ${route.path}`, group: route.group, label: route.label, meaning: route.meaning, change, work, ref: match[1] ? String(match[1]).slice(-6) : '' };
    }
  }
  const key = path.startsWith('/api/') ? 'unknown:api'
    : PROBE.test(path) ? 'unknown:probe'
    : status === 404 ? 'unknown:missing'
    : path.startsWith('/admin') ? 'site:admin'
    : /\.[a-z0-9]{1,6}$/i.test(path) ? 'site:files' : 'site:pages';
  return { key, group: key.split(':')[0], label: FILES[key], meaning: '', change: false, work: false, ref: '' };
}

/** Back from a stored key to the words, for the breakdown. */
export function describeRequestKey(key) {
  const route = LABELS.get(key);
  if (route) return { group: route.group, label: route.label, address: key };
  return { group: key.split(':')[0], label: FILES[key] ?? key, address: '' };
}
