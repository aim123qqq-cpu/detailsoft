import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { LEGAL_VERSION, recordLegalAcceptance } from './legal.mjs';

export const MESSENGER_PROVIDERS = ['telegram', 'max'];
const LOGIN_TTL_MS = 5 * 60 * 1000;
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** One messenger account can create this many centers itself (more go through support). */
export const CENTERS_PER_ACCOUNT = 5;

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

  /** `purpose: 'signup'` opens a request for creating a new center instead of signing in to an existing one. */
  createLoginRequest(provider, purpose = 'login') {
    if (!MESSENGER_PROVIDERS.includes(provider) || !['login', 'signup'].includes(purpose)) return null;
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
    if (purpose === 'signup') this.db.prepare("INSERT INTO login_request_purposes (login_request_id, purpose) VALUES (?, 'signup')").run(id);
    return { id, startToken, shortCode, pollSecret, expiresAt: apiTime(expiresAt), purpose };
  }

  findOpenLogin(provider, { startToken, shortCode }) {
    const row = startToken
      ? this.db.prepare('SELECT * FROM login_requests WHERE start_token_hash = ? AND provider = ?').get(hash(startToken), provider)
      : this.db.prepare(`SELECT * FROM login_requests WHERE provider = ? AND short_code = ?
          AND status IN ('PENDING', 'AWAITING_CONFIRMATION') ORDER BY created_at DESC LIMIT 1`).get(provider, String(shortCode).toUpperCase());
    if (!row || !['PENDING', 'AWAITING_CONFIRMATION'].includes(row.status) || row.expires_at <= nowSql()) return null;
    return row;
  }

  /** 'signup' for a request opened to create a center, 'login' otherwise. */
  loginPurpose(id) {
    return this.db.prepare('SELECT purpose FROM login_request_purposes WHERE login_request_id = ?').get(id)?.purpose ?? 'login';
  }

  markLoginAwaiting(id, externalUserId, externalName = null) {
    this.db.prepare(`UPDATE login_requests SET status = 'AWAITING_CONFIRMATION', external_user_id = ?
      WHERE id = ? AND status IN ('PENDING', 'AWAITING_CONFIRMATION')`).run(String(externalUserId), id);
    this.db.prepare('UPDATE login_request_purposes SET external_name = ? WHERE login_request_id = ?').run(externalName ?? null, id);
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
      memberships: status === 'CONFIRMED' ? this.membershipsFor(row.provider, row.external_user_id) : [],
      purpose: this.loginPurpose(row.id)
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

  /**
   * The confirmed sign-up request becomes a new center: the center, its owner (owner + admin roles)
   * linked to the messenger account that confirmed, and a session — all or nothing.
   */
  createCenterFromLogin(id, pollSecret, input) {
    const status = this.getLoginStatus(id, pollSecret);
    if (!status) return { kind: 'not_found' };
    if (status.purpose !== 'signup') return { kind: 'conflict', code: 'not_a_signup', message: 'Этот запрос открыт для входа, а не для создания центра' };
    if (status.status !== 'CONFIRMED') return { kind: 'conflict', code: 'login_not_confirmed', message: 'Подтвердите создание центра в мессенджере' };
    const centerName = String(input?.centerName ?? '').trim().replace(/\s+/g, ' ');
    const ownerName = String(input?.ownerName ?? '').trim().replace(/\s+/g, ' ');
    if (centerName.length < 2 || centerName.length > 120 || ownerName.length < 2 || ownerName.length > 80) return { kind: 'invalid' };
    // The agreement and the separate consent to the processing of personal data come first (152-FZ art. 9).
    if (input?.acceptedLegal !== LEGAL_VERSION) return { kind: 'conflict', code: 'legal_not_accepted', message: 'Примите пользовательское соглашение и дайте согласие на обработку персональных данных' };
    const row = this.db.prepare(`SELECT l.external_user_id, p.external_name FROM login_requests l
      JOIN login_request_purposes p ON p.login_request_id = l.id WHERE l.id = ?`).get(id);
    const made = this.db.prepare('SELECT COUNT(*) count FROM center_signups WHERE provider = ? AND external_user_id = ?').get(status.provider, row.external_user_id).count;
    if (made >= CENTERS_PER_ACCOUNT) return { kind: 'conflict', code: 'too_many_centers', message: `С одного аккаунта можно создать не больше ${CENTERS_PER_ACCOUNT} центров. Напишите в поддержку, если нужно больше` };

    const tenant = { id: `tenant_${randomUUID()}`, name: centerName };
    const member = { id: `member_${randomUUID()}`, displayName: ownerName, roles: ['admin', 'owner'] };
    const token = `dfs_${randomBytes(32).toString('hex')}`;
    const expiresAt = sqlTime(new Date(Date.now() + SESSION_TTL_MS));
    this.db.exec('BEGIN');
    try {
      const consumed = this.db.prepare(`UPDATE login_requests SET status = 'CONSUMED' WHERE id = ? AND status = 'CONFIRMED'`).run(id);
      if (consumed.changes !== 1) throw new Error('login_already_consumed');
      this.db.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').run(tenant.id, tenant.name);
      this.db.prepare('INSERT INTO tenant_members (id, tenant_id, display_name, roles_json) VALUES (?, ?, ?, ?)')
        .run(member.id, tenant.id, member.displayName, JSON.stringify(member.roles));
      this.db.prepare(`INSERT INTO member_messenger_links (id, tenant_id, member_id, provider, external_user_id, external_name)
        VALUES (?, ?, ?, ?, ?, ?)`).run(`ml_${randomUUID()}`, tenant.id, member.id, status.provider, row.external_user_id, row.external_name ?? null);
      recordLegalAcceptance(this.db, tenant.id, member.id, 'signup');
      this.db.prepare('INSERT INTO center_signups (tenant_id, provider, external_user_id) VALUES (?, ?, ?)').run(tenant.id, status.provider, row.external_user_id);
      this.db.prepare(`INSERT INTO auth_sessions (id, tenant_id, member_id, token_hash, provider, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(`ses_${randomUUID()}`, tenant.id, member.id, hash(token), status.provider, expiresAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error.message === 'login_already_consumed') return { kind: 'conflict', code: 'login_not_confirmed', message: 'Запрос уже использован' };
      throw error;
    }
    return { kind: 'created', session: { token, expiresAt: apiTime(expiresAt), tenant, member } };
  }

  authenticateSession(token) {
    if (typeof token !== 'string' || !token.startsWith('dfs_')) return null;
    const row = this.db.prepare(`SELECT s.tenant_id, s.member_id, s.provider, m.display_name, m.roles_json
      FROM auth_sessions s
      JOIN tenant_members m ON m.id = s.member_id AND m.tenant_id = s.tenant_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND m.status = 'active'`).get(hash(token), nowSql());
    return row ? { tenantId: row.tenant_id, memberId: row.member_id, provider: row.provider, displayName: row.display_name, roles: JSON.parse(row.roles_json) } : null;
  }

  /**
   * Retention: what has served its purpose is deleted, not kept forever. Login requests live a day after
   * they expire; ended sessions (signed out or expired) and used or expired invites live 30 days, for
   * questions like "who signed in when", then go.
   */
  purgeExpired(now = new Date()) {
    const dayAgo = sqlTime(new Date(now.getTime() - 86_400_000));
    const monthAgo = sqlTime(new Date(now.getTime() - 30 * 86_400_000));
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM login_request_purposes WHERE login_request_id IN (SELECT id FROM login_requests WHERE expires_at < ?)').run(dayAgo);
      const logins = this.db.prepare('DELETE FROM login_requests WHERE expires_at < ?').run(dayAgo).changes;
      const sessions = this.db.prepare('DELETE FROM auth_sessions WHERE expires_at < ? OR revoked_at < ?').run(monthAgo, monthAgo).changes;
      const invites = this.db.prepare('DELETE FROM messenger_invites WHERE expires_at < ? OR used_at < ?').run(monthAgo, monthAgo).changes;
      this.db.prepare('DELETE FROM admin_sessions WHERE expires_at < ? OR revoked_at < ?').run(monthAgo, monthAgo);
      this.db.exec('COMMIT');
      return { logins, sessions, invites };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** The owner of the DetailFlow service: messenger accounts let into /admin (scripts/platform-admin.mjs). */
  isPlatformAdmin(provider, externalUserId) {
    return Boolean(this.db.prepare('SELECT 1 FROM platform_admins WHERE provider = ? AND external_user_id = ?').get(provider, String(externalUserId)));
  }

  listPlatformAdmins() {
    return this.db.prepare('SELECT provider, external_user_id AS externalUserId FROM platform_admins ORDER BY added_at').all();
  }

  /** A sign-in confirmed in the bot by an admin account becomes an admin session (12 hours). */
  createAdminSession(id, pollSecret) {
    const status = this.getLoginStatus(id, pollSecret);
    if (!status) return { kind: 'not_found' };
    if (status.status !== 'CONFIRMED') return { kind: 'conflict', code: 'login_not_confirmed', message: 'Вход ещё не подтверждён в мессенджере' };
    const row = this.db.prepare('SELECT provider, external_user_id FROM login_requests WHERE id = ?').get(id);
    if (!this.isPlatformAdmin(row.provider, row.external_user_id)) return { kind: 'forbidden' };
    const consumed = this.db.prepare(`UPDATE login_requests SET status = 'CONSUMED' WHERE id = ? AND status = 'CONFIRMED'`).run(id);
    if (consumed.changes !== 1) return { kind: 'conflict', code: 'login_already_consumed', message: 'Этот вход уже использован' };
    const token = `dfa_${randomBytes(32).toString('hex')}`;
    const expiresAt = sqlTime(new Date(Date.now() + 12 * 60 * 60 * 1000));
    this.db.prepare('INSERT INTO admin_sessions (token_hash, provider, external_user_id, expires_at) VALUES (?, ?, ?, ?)')
      .run(hash(token), row.provider, row.external_user_id, expiresAt);
    return { kind: 'created', token, expiresAt: apiTime(expiresAt) };
  }

  authenticateAdmin(token) {
    if (typeof token !== 'string' || !token.startsWith('dfa_')) return null;
    const row = this.db.prepare(`SELECT s.provider, s.external_user_id FROM admin_sessions s
      JOIN platform_admins a ON a.provider = s.provider AND a.external_user_id = s.external_user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`).get(hash(token), nowSql());
    return row ? { provider: row.provider, externalUserId: row.external_user_id } : null;
  }

  revokeAdminSession(token) {
    if (typeof token !== 'string') return false;
    return this.db.prepare('UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(nowSql(), hash(token)).changes === 1;
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

  /**
   * An employee deletes their own account in this center (stores require it). Access ends and personal data
   * goes: the name, messenger links (account id and name), pending sign-ins, invites, access codes, sessions.
   * Orders, acts and audit records stay: they are the center's business records. The only owner of a
   * center cannot leave it without a manager.
   */
  deleteOwnAccount(tenantId, memberId) {
    const member = this.db.prepare(`SELECT roles_json FROM tenant_members WHERE id = ? AND tenant_id = ? AND status = 'active'`).get(memberId, tenantId);
    if (!member) return { kind: 'not_found' };
    if (JSON.parse(member.roles_json).includes('owner')) {
      const owners = this.db.prepare(`SELECT roles_json FROM tenant_members WHERE tenant_id = ? AND status = 'active' AND id <> ?`).all(tenantId, memberId)
        .filter((row) => JSON.parse(row.roles_json).includes('owner'));
      if (!owners.length) return { kind: 'last_owner' };
    }
    const now = nowSql();
    this.db.exec('BEGIN');
    try {
      const externalIds = this.db.prepare('SELECT provider, external_user_id FROM member_messenger_links WHERE tenant_id = ? AND member_id = ?').all(tenantId, memberId);
      for (const link of externalIds) {
        this.db.prepare('DELETE FROM login_requests WHERE provider = ? AND external_user_id = ?').run(link.provider, link.external_user_id);
      }
      this.db.prepare('DELETE FROM member_messenger_links WHERE tenant_id = ? AND member_id = ?').run(tenantId, memberId);
      this.db.prepare('DELETE FROM messenger_invites WHERE tenant_id = ? AND member_id = ?').run(tenantId, memberId);
      this.db.prepare('DELETE FROM tenant_member_tokens WHERE tenant_id = ? AND member_id = ?').run(tenantId, memberId);
      this.db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE tenant_id = ? AND member_id = ? AND revoked_at IS NULL').run(now, tenantId, memberId);
      this.db.prepare(`UPDATE tenant_members SET display_name = 'Удалённый сотрудник', roles_json = '[]', status = 'blocked', updated_at = ?
        WHERE id = ? AND tenant_id = ?`).run(now, memberId, tenantId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'deleted' };
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
