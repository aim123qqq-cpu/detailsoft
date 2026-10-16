import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

export const MESSENGER_PROVIDERS = ['telegram', 'max'];
const LOGIN_TTL_MS = 5 * 60 * 1000;
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
// Same text format as SQLite CURRENT_TIMESTAMP (UTC), so values compare lexicographically.
const sqlTime = (date) => date.toISOString().replace('T', ' ').slice(0, 19);
const nowSql = () => sqlTime(new Date());
const apiTime = (value) => value ? new Date(`${value.replace(' ', 'T')}Z`).toISOString() : null;

function sameSecret(expectedHash, secret) {
  const actual = Buffer.from(hash(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Messenger sign-in, invites and sessions. Tenant scope comes only from stored links and sessions. */
export class AuthRepository {
  constructor(db) {
    this.db = db;
  }

  createLoginRequest(provider) {
    if (!MESSENGER_PROVIDERS.includes(provider)) return null;
    const id = `lr_${randomUUID()}`;
    const startToken = randomBytes(16).toString('hex');
    const pollSecret = randomBytes(32).toString('hex');
    let shortCode = '';
    do {
      shortCode = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.db.prepare(`SELECT 1 FROM login_requests WHERE provider = ? AND short_code = ?
      AND status IN ('PENDING', 'AWAITING_CONFIRMATION') AND expires_at > ?`).get(provider, shortCode, nowSql()));
    const expiresAt = sqlTime(new Date(Date.now() + LOGIN_TTL_MS));
    this.db.prepare(`INSERT INTO login_requests (id, provider, start_token_hash, short_code, poll_secret_hash, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, provider, hash(startToken), shortCode, hash(pollSecret), expiresAt);
    return { id, startToken, shortCode, pollSecret, expiresAt: apiTime(expiresAt) };
  }

  findOpenLogin(provider, { startToken, shortCode }) {
    const row = startToken
      ? this.db.prepare('SELECT * FROM login_requests WHERE start_token_hash = ? AND provider = ?').get(hash(startToken), provider)
      : this.db.prepare(`SELECT * FROM login_requests WHERE provider = ? AND short_code = ?
          AND status IN ('PENDING', 'AWAITING_CONFIRMATION') ORDER BY created_at DESC LIMIT 1`).get(provider, String(shortCode).toUpperCase());
    if (!row || !['PENDING', 'AWAITING_CONFIRMATION'].includes(row.status) || row.expires_at <= nowSql()) return null;
    return row;
  }

  markLoginAwaiting(id, externalUserId) {
    this.db.prepare(`UPDATE login_requests SET status = 'AWAITING_CONFIRMATION', external_user_id = ?
      WHERE id = ? AND status IN ('PENDING', 'AWAITING_CONFIRMATION')`).run(String(externalUserId), id);
  }

  /** Only the messenger account that opened the request can confirm or deny it. */
  decideLogin(id, provider, externalUserId, approve) {
    const row = this.db.prepare('SELECT * FROM login_requests WHERE id = ? AND provider = ?').get(id, provider);
    if (!row || row.status !== 'AWAITING_CONFIRMATION' || row.external_user_id !== String(externalUserId) || row.expires_at <= nowSql()) return false;
    this.db.prepare('UPDATE login_requests SET status = ? WHERE id = ?').run(approve ? 'CONFIRMED' : 'DENIED', id);
    return true;
  }

  membershipsFor(provider, externalUserId) {
    return this.db.prepare(`SELECT m.id member_id, m.display_name, m.roles_json, t.id tenant_id, t.name tenant_name
      FROM member_messenger_links l
      JOIN tenant_members m ON m.id = l.member_id AND m.tenant_id = l.tenant_id
      JOIN tenants t ON t.id = l.tenant_id
      WHERE l.provider = ? AND l.external_user_id = ? AND m.status = 'active'
      ORDER BY t.name`).all(provider, String(externalUserId)).map((row) => ({
        tenant: { id: row.tenant_id, name: row.tenant_name },
        member: { id: row.member_id, displayName: row.display_name, roles: JSON.parse(row.roles_json) }
      }));
  }

  getLoginStatus(id, pollSecret) {
    const row = this.db.prepare('SELECT * FROM login_requests WHERE id = ?').get(id);
    if (!row || typeof pollSecret !== 'string' || !sameSecret(row.poll_secret_hash, pollSecret)) return null;
    const expired = row.expires_at <= nowSql() && row.status !== 'CONSUMED';
    const status = expired ? 'EXPIRED' : row.status;
    return {
      id: row.id,
      provider: row.provider,
      status,
      expiresAt: apiTime(row.expires_at),
      memberships: status === 'CONFIRMED' ? this.membershipsFor(row.provider, row.external_user_id) : []
    };
  }

  createSessionFromLogin(id, pollSecret, tenantId = null) {
    const status = this.getLoginStatus(id, pollSecret);
    if (!status) return { kind: 'not_found' };
    if (status.status !== 'CONFIRMED') return { kind: 'conflict', code: 'login_not_confirmed', message: 'Вход ещё не подтверждён в мессенджере' };
    const options = status.memberships;
    const chosen = tenantId ? options.find((option) => option.tenant.id === tenantId) : options.length === 1 ? options[0] : null;
    if (!options.length) return { kind: 'conflict', code: 'no_active_membership', message: 'Аккаунт не привязан к активному сотруднику' };
    if (!chosen) return tenantId
      ? { kind: 'conflict', code: 'tenant_not_available', message: 'Этот центр недоступен для аккаунта' }
      : { kind: 'choose_tenant', memberships: options };
    const token = `dfs_${randomBytes(32).toString('hex')}`;
    const expiresAt = sqlTime(new Date(Date.now() + SESSION_TTL_MS));
    this.db.exec('BEGIN');
    try {
      const consumed = this.db.prepare(`UPDATE login_requests SET status = 'CONSUMED' WHERE id = ? AND status = 'CONFIRMED'`).run(id);
      if (consumed.changes !== 1) throw new Error('login_already_consumed');
      this.db.prepare(`INSERT INTO auth_sessions (id, tenant_id, member_id, token_hash, provider, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(`ses_${randomUUID()}`, chosen.tenant.id, chosen.member.id, hash(token), status.provider, expiresAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error.message === 'login_already_consumed') return { kind: 'conflict', code: 'login_not_confirmed', message: 'Вход уже использован' };
      throw error;
    }
    return { kind: 'created', session: { token, expiresAt: apiTime(expiresAt), tenant: chosen.tenant, member: chosen.member } };
  }

  authenticateSession(token) {
    if (typeof token !== 'string' || !token.startsWith('dfs_')) return null;
    const row = this.db.prepare(`SELECT s.tenant_id, s.member_id, m.display_name, m.roles_json
      FROM auth_sessions s
      JOIN tenant_members m ON m.id = s.member_id AND m.tenant_id = s.tenant_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND m.status = 'active'`).get(hash(token), nowSql());
    return row ? { tenantId: row.tenant_id, memberId: row.member_id, displayName: row.display_name, roles: JSON.parse(row.roles_json) } : null;
  }

  revokeSession(token) {
    if (typeof token !== 'string') return false;
    return this.db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
      .run(nowSql(), hash(token)).changes === 1;
  }

  createInvite(tenantId, memberId, provider) {
    if (!MESSENGER_PROVIDERS.includes(provider)) return { kind: 'invalid' };
    const member = this.db.prepare(`SELECT id, status FROM tenant_members WHERE id = ? AND tenant_id = ?`).get(memberId, tenantId);
    if (!member) return { kind: 'not_found' };
    if (member.status !== 'active') return { kind: 'conflict', code: 'member_blocked', message: 'Сотрудник заблокирован' };
    const code = `invite_${randomBytes(12).toString('hex')}`;
    const expiresAt = sqlTime(new Date(Date.now() + INVITE_TTL_MS));
    this.db.prepare(`INSERT INTO messenger_invites (id, tenant_id, member_id, provider, code_hash, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(`mi_${randomUUID()}`, tenantId, memberId, provider, hash(code), expiresAt);
    return { kind: 'created', invite: { code, provider, expiresAt: apiTime(expiresAt) } };
  }

  redeemInvite(provider, code, externalUserId, externalName) {
    const invite = this.db.prepare(`SELECT i.*, m.display_name, m.status member_status, t.name tenant_name
      FROM messenger_invites i
      JOIN tenant_members m ON m.id = i.member_id AND m.tenant_id = i.tenant_id
      JOIN tenants t ON t.id = i.tenant_id
      WHERE i.code_hash = ? AND i.provider = ?`).get(hash(code), provider);
    if (!invite || invite.used_at || invite.expires_at <= nowSql() || invite.member_status !== 'active') return { kind: 'invalid' };
    const otherMember = this.db.prepare(`SELECT member_id FROM member_messenger_links
      WHERE tenant_id = ? AND provider = ? AND external_user_id = ? AND member_id <> ?`)
      .get(invite.tenant_id, provider, String(externalUserId), invite.member_id);
    if (otherMember) return { kind: 'conflict' };
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM member_messenger_links WHERE member_id = ? AND provider = ?').run(invite.member_id, provider);
      this.db.prepare(`INSERT INTO member_messenger_links (id, tenant_id, member_id, provider, external_user_id, external_name)
        VALUES (?, ?, ?, ?, ?, ?)`).run(`ml_${randomUUID()}`, invite.tenant_id, invite.member_id, provider, String(externalUserId), externalName ?? null);
      this.db.prepare('UPDATE messenger_invites SET used_at = ? WHERE id = ?').run(nowSql(), invite.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'linked', tenantName: invite.tenant_name, memberName: invite.display_name };
  }

  listMessengerLinks(tenantId) {
    return this.db.prepare(`SELECT id, member_id, provider, external_name, linked_at FROM member_messenger_links
      WHERE tenant_id = ? ORDER BY provider`).all(tenantId).map((row) => ({
        id: row.id, memberId: row.member_id, provider: row.provider, externalName: row.external_name, linkedAt: apiTime(row.linked_at)
      }));
  }

  /** Unlinking also ends the member's sessions opened through that messenger. */
  removeMessengerLink(tenantId, memberId, linkId) {
    const link = this.db.prepare('SELECT provider FROM member_messenger_links WHERE id = ? AND tenant_id = ? AND member_id = ?')
      .get(linkId, tenantId, memberId);
    if (!link) return false;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM member_messenger_links WHERE id = ?').run(linkId);
      this.db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE tenant_id = ? AND member_id = ? AND provider = ? AND revoked_at IS NULL`)
        .run(nowSql(), tenantId, memberId, link.provider);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return true;
  }
}
