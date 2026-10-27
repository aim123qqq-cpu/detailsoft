// The current edition of the user agreement (/terms/) and of the consent to the processing of personal
// data (/consent/). Changing either document means a new edition here: everyone is asked to accept again.
export const LEGAL_VERSION = '2026-10-27';

/** Records that a member accepted both documents of the current edition (idempotent). */
export function recordLegalAcceptance(db, tenantId, memberId, method) {
  const insert = db.prepare(`INSERT OR IGNORE INTO legal_acceptances (tenant_id, member_id, document, version, method)
    VALUES (?, ?, ?, ?, ?)`);
  for (const document of ['terms', 'consent']) insert.run(tenantId, memberId, document, LEGAL_VERSION, method);
}

/** Whether a member has accepted both documents of the current edition. */
export function hasAcceptedLegal(db, memberId) {
  return db.prepare('SELECT COUNT(*) AS count FROM legal_acceptances WHERE member_id = ? AND version = ?')
    .get(memberId, LEGAL_VERSION).count === 2;
}
