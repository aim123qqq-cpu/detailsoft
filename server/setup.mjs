import { randomUUID } from 'node:crypto';
import { DetailFlowRepository } from './repository.mjs';
import { AuthRepository, MESSENGER_PROVIDERS } from './auth-repository.mjs';

/**
 * First-run setup from the server console: creates a center with its owner (or adds an owner
 * to an existing center when access was lost) and returns messenger invites for that owner.
 * Console access to the database file is already full trust, so no session is required.
 */
export function setupOwner(db, { centerName, tenantId, ownerName, providers = MESSENGER_PROVIDERS } = {}) {
  const repository = new DetailFlowRepository(db);
  const auth = new AuthRepository(db);
  const center = String(centerName ?? '').trim();
  const owner = String(ownerName ?? '').trim();
  if (owner.length < 2 || owner.length > 80) return { kind: 'invalid', message: 'Укажите имя владельца: --owner "Имя Фамилия" (от 2 до 80 символов)' };
  if (!providers.length || providers.some((provider) => !MESSENGER_PROVIDERS.includes(provider))) {
    return { kind: 'invalid', message: `Мессенджер: ${MESSENGER_PROVIDERS.join(' или ')}` };
  }

  let tenant;
  if (tenantId) {
    tenant = db.prepare('SELECT id, name FROM tenants WHERE id = ?').get(tenantId);
    if (!tenant) return { kind: 'not_found', message: `Центр ${tenantId} не найден` };
  } else {
    if (center.length < 2 || center.length > 120) return { kind: 'invalid', message: 'Укажите название центра: --center "Название"' };
    const sameName = db.prepare('SELECT id FROM tenants WHERE name = ?').get(center);
    if (sameName) return { kind: 'conflict', message: `Центр «${center}» уже есть (${sameName.id}). Чтобы добавить владельца, используйте --tenant ${sameName.id}` };
    tenant = { id: `tenant_${randomUUID()}`, name: center };
    db.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').run(tenant.id, tenant.name);
  }

  // Inputs are validated above, so the member is created; an invite is valid for 24 hours.
  const { member } = repository.createTeamMember(tenant.id, { displayName: owner, roles: ['owner', 'admin'] });
  const invites = providers.map((provider) => auth.createInvite(tenant.id, member.id, provider).invite);
  return { kind: 'created', tenant: { id: tenant.id, name: tenant.name }, member, invites };
}
