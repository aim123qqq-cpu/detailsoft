import { createHash, randomBytes, randomUUID, timeToMinutes, mapTeamMember } from './shared.mjs';

/** Team members, legacy access tokens and the center schedule. Mixed into DetailFlowRepository (server/repository.mjs). */
export const centerMethods = {
  authenticateTeamToken(token) {
    if (!token) return null;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = this.db.prepare(`SELECT member.tenant_id, member.display_name, member.roles_json
      FROM tenant_member_tokens token
      JOIN tenant_members member ON member.id = token.member_id AND member.tenant_id = token.tenant_id
      WHERE token.token_hash = ? AND member.status = 'active'`).get(tokenHash);
    return row ? {
      tenantId: row.tenant_id,
      displayName: row.display_name,
      roles: JSON.parse(row.roles_json)
    } : null;
  },

  listTeamMembers(tenantId) {
    return this.db.prepare(`SELECT id, display_name, roles_json, status, created_at, updated_at
      FROM tenant_members WHERE tenant_id = ?
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, display_name COLLATE NOCASE`)
      .all(tenantId).map(mapTeamMember);
  },

  createTeamMember(tenantId, input) {
    const displayName = String(input?.displayName ?? '').trim();
    const roles = Array.isArray(input?.roles) ? [...new Set(input.roles)].sort() : [];
    const assignable = this.roles.assignableKeys(tenantId);
    if (displayName.length < 2 || displayName.length > 80 || !roles.length ||
      roles.some((role) => !assignable.has(role))) return { kind: 'invalid' };
    const id = `member_${randomUUID()}`;
    const accessToken = `df_${randomBytes(24).toString('hex')}`;
    const tokenHash = createHash('sha256').update(accessToken).digest('hex');
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO tenant_members
        (id, tenant_id, display_name, roles_json) VALUES (?, ?, ?, ?)`)
        .run(id, tenantId, displayName, JSON.stringify(roles));
      this.db.prepare(`INSERT INTO tenant_member_tokens
        (id, tenant_id, member_id, token_hash) VALUES (?, ?, ?, ?)`)
        .run(`member_token_${randomUUID()}`, tenantId, id, tokenHash);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const member = this.db.prepare(`SELECT id, display_name, roles_json, status, created_at, updated_at
      FROM tenant_members WHERE id = ? AND tenant_id = ?`).get(id, tenantId);
    return { kind: 'created', member: mapTeamMember(member), accessToken };
  },

  updateTeamMember(tenantId, memberId, input) {
    const current = this.db.prepare(`SELECT id, display_name, roles_json, status, created_at, updated_at
      FROM tenant_members WHERE id = ? AND tenant_id = ?`).get(memberId, tenantId);
    if (!current) return { kind: 'not_found' };
    const hasRoles = Array.isArray(input?.roles);
    const hasStatus = input?.status !== undefined;
    if (!hasRoles && !hasStatus) return { kind: 'invalid' };
    const roles = hasRoles ? [...new Set(input.roles)].sort() : JSON.parse(current.roles_json);
    const status = hasStatus ? input.status : current.status;
    const assignable = this.roles.assignableKeys(tenantId);
    if (!roles.length || roles.some((role) => !assignable.has(role)) ||
      !['active', 'blocked'].includes(status)) return { kind: 'invalid' };
    const wasActiveOwner = current.status === 'active' && JSON.parse(current.roles_json).includes('owner');
    const remainsActiveOwner = status === 'active' && roles.includes('owner');
    if (wasActiveOwner && !remainsActiveOwner) {
      const activeOwners = this.db.prepare(`SELECT roles_json FROM tenant_members
        WHERE tenant_id = ? AND status = 'active'`).all(tenantId)
        .filter((member) => JSON.parse(member.roles_json).includes('owner')).length;
      if (activeOwners <= 1) return { kind: 'conflict' };
    }
    this.db.prepare(`UPDATE tenant_members SET roles_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND tenant_id = ?`).run(JSON.stringify(roles), status, memberId, tenantId);
    const updated = this.db.prepare(`SELECT id, display_name, roles_json, status, created_at, updated_at
      FROM tenant_members WHERE id = ? AND tenant_id = ?`).get(memberId, tenantId);
    return { kind: 'updated', member: mapTeamMember(updated) };
  },

  getCenterSettings(tenantId) {
    const row = this.db.prepare(`SELECT tenant.timezone, settings.working_days_json, settings.open_time,
        settings.close_time, settings.slot_step_minutes,
        COALESCE(settings.simultaneous_capacity, legacy.simultaneous_capacity, 1) simultaneous_capacity
      FROM tenants tenant
      LEFT JOIN tenant_operating_settings settings ON settings.tenant_id = tenant.id
      LEFT JOIN tenant_booking_settings legacy ON legacy.tenant_id = tenant.id
      WHERE tenant.id = ?`).get(tenantId);
    if (!row) return null;
    return {
      timezone: row.timezone,
      workingDays: row.working_days_json ? JSON.parse(row.working_days_json) : [0, 1, 2, 3, 4, 5, 6],
      openTime: row.open_time ?? '09:00',
      closeTime: row.close_time ?? '20:00',
      slotStepMinutes: row.slot_step_minutes ?? 30,
      simultaneousCapacity: row.simultaneous_capacity ?? 1
    };
  },

  updateCenterSettings(tenantId, input) {
    const tenant = this.db.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
    if (!tenant || typeof input !== 'object' || !input) return { kind: tenant ? 'invalid' : 'not_found' };
    const workingDays = Array.isArray(input.workingDays) ? [...new Set(input.workingDays)].sort((left, right) => left - right) : [];
    const openTime = String(input.openTime ?? '');
    const closeTime = String(input.closeTime ?? '');
    const openMinutes = timeToMinutes(openTime);
    const closeMinutes = timeToMinutes(closeTime);
    const slotStepMinutes = Number(input.slotStepMinutes);
    const simultaneousCapacity = Number(input.simultaneousCapacity);
    if (!workingDays.length || workingDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
      openMinutes === null || closeMinutes === null || closeMinutes - openMinutes < 60 ||
      ![15, 30, 60, 90, 120].includes(slotStepMinutes) ||
      !Number.isInteger(simultaneousCapacity) || simultaneousCapacity < 1 || simultaneousCapacity > 20) {
      return { kind: 'invalid' };
    }
    this.db.prepare(`INSERT INTO tenant_operating_settings
      (tenant_id, working_days_json, open_time, close_time, slot_step_minutes, simultaneous_capacity, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(tenant_id) DO UPDATE SET working_days_json = excluded.working_days_json,
        open_time = excluded.open_time, close_time = excluded.close_time,
        slot_step_minutes = excluded.slot_step_minutes, simultaneous_capacity = excluded.simultaneous_capacity,
        updated_at = CURRENT_TIMESTAMP`).run(
          tenantId, JSON.stringify(workingDays), openTime, closeTime, slotStepMinutes, simultaneousCapacity
        );
    return { kind: 'updated', settings: this.getCenterSettings(tenantId) };
  }
};
