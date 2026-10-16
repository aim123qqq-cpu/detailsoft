import { randomUUID } from 'node:crypto';

/** Permissions an owner can grant with checkboxes. manageTeam is not here: it belongs to the owner role only. */
export const PERMISSIONS = [
  { key: 'viewAnalytics', title: 'Статистика', note: 'Выручка, загрузка и итоги центра' },
  { key: 'manageBookings', title: 'Записи и обращения', note: 'Создание, перенос, отмена и неявка, обращения' },
  { key: 'manageCustomers', title: 'Клиенты и автомобили', note: 'Карточки, телефоны и госномера, история' },
  { key: 'manageIntake', title: 'Приёмка', note: 'Осмотр, фото, акт приёмки' },
  { key: 'approveEstimates', title: 'Смета и согласование', note: 'Версии сметы и решение клиента' },
  { key: 'assignMasters', title: 'Назначение мастера', note: 'Выбор исполнителя заказа' },
  { key: 'performWork', title: 'Выполнение работ', note: 'Отметка операций и пауз' },
  { key: 'acceptAssignments', title: 'Исполнитель заказов', note: 'Попадает в список мастеров и видит «Мои» заказы' },
  { key: 'closeOrders', title: 'Выдача и закрытие', note: 'Выдача автомобиля, акт выдачи' },
  { key: 'manageCatalog', title: 'Каталог услуг', note: 'Услуги, цены и время работ' },
  { key: 'manageSettings', title: 'График центра', note: 'Рабочие дни, часы и вместимость' }
];
const PERMISSION_KEYS = PERMISSIONS.map((permission) => permission.key);

// The owner has every access right; being an order executor is a job, not access, so an owner who
// also works on cars holds the master role (or another role with acceptAssignments) as well.
export const SYSTEM_ROLES = {
  owner: { name: 'Владелец', permissions: [...PERMISSION_KEYS.filter((key) => key !== 'acceptAssignments'), 'manageTeam'], locked: true },
  admin: { name: 'Администратор', permissions: PERMISSION_KEYS.filter((key) => key !== 'acceptAssignments') },
  intake: { name: 'Приёмщик', permissions: ['manageIntake'] },
  master: { name: 'Мастер', permissions: ['performWork', 'acceptAssignments'] }
};

const nameKey = (value) => String(value).trim().toLocaleLowerCase('ru-RU');

function cleanPermissions(input) {
  if (!Array.isArray(input) || input.some((key) => !PERMISSION_KEYS.includes(key))) return null;
  return PERMISSION_KEYS.filter((key) => input.includes(key));
}

export class RolesRepository {
  constructor(db) {
    this.db = db;
  }

  /** All roles of a center: system roles with their current permissions, then custom ones. */
  listRoles(tenantId, { includeArchived = false } = {}) {
    const rows = this.db.prepare('SELECT * FROM tenant_roles WHERE tenant_id = ? ORDER BY created_at, name').all(tenantId);
    // Blocked members count too: an archived role would otherwise block restoring their access.
    const members = this.db.prepare('SELECT roles_json FROM tenant_members WHERE tenant_id = ?').all(tenantId)
      .map((member) => JSON.parse(member.roles_json));
    const memberCount = (key) => members.filter((roles) => roles.includes(key)).length;
    const system = Object.entries(SYSTEM_ROLES).map(([key, role]) => {
      const override = rows.find((row) => row.key === key);
      return {
        key, name: role.name, system: true, locked: Boolean(role.locked), archived: false,
        permissions: role.locked || !override ? role.permissions : JSON.parse(override.permissions_json),
        memberCount: memberCount(key)
      };
    });
    const custom = rows.filter((row) => !SYSTEM_ROLES[row.key] && (includeArchived || !row.archived_at)).map((row) => ({
      key: row.key, name: row.name, system: false, locked: false, archived: Boolean(row.archived_at),
      permissions: JSON.parse(row.permissions_json), memberCount: memberCount(row.key)
    }));
    return [...system, ...custom];
  }

  /** Effective permissions of a set of role keys. Unknown and archived keys grant nothing. */
  permissionsFor(tenantId, roleKeys) {
    const keys = new Set(roleKeys ?? []);
    const granted = new Set();
    for (const role of this.listRoles(tenantId)) {
      if (keys.has(role.key)) role.permissions.forEach((permission) => granted.add(permission));
    }
    return granted;
  }

  /** Role keys that can be given to a member right now. */
  assignableKeys(tenantId) {
    return new Set(this.listRoles(tenantId).map((role) => role.key));
  }

  createRole(tenantId, input, actorName) {
    const name = String(input?.name ?? '').trim();
    const permissions = cleanPermissions(input?.permissions);
    if (name.length < 2 || name.length > 40 || !permissions?.length) return { kind: 'invalid' };
    if (this.#nameTaken(tenantId, name)) return { kind: 'conflict', code: 'role_name_taken', message: 'Роль с таким названием уже есть' };
    const key = `role_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO tenant_roles (tenant_id, key, name, permissions_json) VALUES (?, ?, ?, ?)')
        .run(tenantId, key, name, JSON.stringify(permissions));
      this.#event(tenantId, key, 'ROLE_CREATED', actorName, { name, permissions });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'created', role: this.#role(tenantId, key) };
  }

  updateRole(tenantId, key, input, actorName) {
    const current = this.#role(tenantId, key, { includeArchived: true });
    if (!current) return { kind: 'not_found' };
    if (current.locked) return { kind: 'conflict', code: 'role_locked', message: 'Права владельца не меняются' };
    const hasName = input?.name !== undefined;
    const hasPermissions = input?.permissions !== undefined;
    if (!hasName && !hasPermissions) return { kind: 'invalid' };
    const name = hasName ? String(input.name).trim() : current.name;
    const permissions = hasPermissions ? cleanPermissions(input.permissions) : current.permissions;
    if (current.system && hasName && name !== current.name) return { kind: 'conflict', code: 'role_name_locked', message: 'Системную роль нельзя переименовать' };
    if (name.length < 2 || name.length > 40 || !permissions?.length) return { kind: 'invalid' };
    if (nameKey(name) !== nameKey(current.name) && this.#nameTaken(tenantId, name)) {
      return { kind: 'conflict', code: 'role_name_taken', message: 'Роль с таким названием уже есть' };
    }
    const changes = {};
    if (name !== current.name) changes.name = { from: current.name, to: name };
    if (permissions.join() !== current.permissions.join()) changes.permissions = { from: current.permissions, to: permissions };
    if (!Object.keys(changes).length) return { kind: 'updated', role: current };
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO tenant_roles (tenant_id, key, name, permissions_json) VALUES (?, ?, ?, ?)
        ON CONFLICT(tenant_id, key) DO UPDATE SET name = excluded.name, permissions_json = excluded.permissions_json,
          updated_at = CURRENT_TIMESTAMP`).run(tenantId, key, name, JSON.stringify(permissions));
      this.#event(tenantId, key, 'ROLE_UPDATED', actorName, changes);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', role: this.#role(tenantId, key, { includeArchived: true }) };
  }

  /** Archiving hides a custom role from assignment; history keeps it. A role still held by someone stays. */
  setRoleArchived(tenantId, key, archived, actorName) {
    const current = this.#role(tenantId, key, { includeArchived: true });
    if (!current) return { kind: 'not_found' };
    if (current.system) return { kind: 'conflict', code: 'role_locked', message: 'Системную роль нельзя архивировать' };
    if (current.archived === archived) return { kind: 'updated', role: current };
    if (archived && current.memberCount > 0) {
      return { kind: 'conflict', code: 'role_in_use', message: `Роль есть у сотрудников (${current.memberCount}). Сначала смените им роль` };
    }
    if (!archived && this.#nameTaken(tenantId, current.name)) {
      return { kind: 'conflict', code: 'role_name_taken', message: 'Роль с таким названием уже есть' };
    }
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE tenant_roles SET archived_at = ${archived ? 'CURRENT_TIMESTAMP' : 'NULL'}, updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ? AND key = ?`).run(tenantId, key);
      this.#event(tenantId, key, archived ? 'ROLE_ARCHIVED' : 'ROLE_RESTORED', actorName, {});
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', role: this.#role(tenantId, key, { includeArchived: true }) };
  }

  listRoleEvents(tenantId, key) {
    return this.db.prepare(`SELECT event_type, actor_name, details_json, created_at FROM tenant_role_events
      WHERE tenant_id = ? AND role_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 50`).all(tenantId, key)
      .map((row) => ({ eventType: row.event_type, actorName: row.actor_name, details: JSON.parse(row.details_json), createdAt: `${row.created_at.replace(' ', 'T')}Z` }));
  }

  #role(tenantId, key, options) {
    return this.listRoles(tenantId, options).find((role) => role.key === key) ?? null;
  }

  #nameTaken(tenantId, name) {
    return this.listRoles(tenantId).some((role) => nameKey(role.name) === nameKey(name));
  }

  #event(tenantId, key, type, actorName, details) {
    this.db.prepare(`INSERT INTO tenant_role_events (id, tenant_id, role_key, event_type, actor_name, details_json)
      VALUES (?, ?, ?, ?, ?, ?)`).run(`role_event_${randomUUID()}`, tenantId, key, type, actorName ?? 'Сотрудник', JSON.stringify(details));
  }
}
