// Messages from the DetailFlow service to the people of the centers: news, updates and short surveys,
// written in /admin by the service owner. They go only to those who keep "news and surveys" on, into the
// feed, a copy through the bot and the device. Survey results show answers and center names, not people.
import { randomUUID } from 'node:crypto';

const KINDS = { news: 'Новость', update: 'Обновление', survey: 'Опрос' };
const AUDIENCES = ['all', 'admins', 'center'];

export function createBroadcasts({ db, repository, notifications }) {
  /** Active members the message is for, who keep news and surveys on, grouped by center. */
  function recipients({ audience, tenantId = null }) {
    const members = db.prepare(`SELECT m.id, m.tenant_id, m.roles_json FROM tenant_members m
      LEFT JOIN member_notification_prefs p ON p.member_id = m.id
      WHERE m.status = 'active' AND COALESCE(p.news, 1) = 1 AND (? IS NULL OR m.tenant_id = ?)`).all(tenantId, tenantId)
      .filter((member) => audience !== 'admins' || repository.roles.permissionsFor(member.tenant_id, JSON.parse(member.roles_json)).has('manageSettings'));
    const byCenter = new Map();
    for (const member of members) byCenter.set(member.tenant_id, [...(byCenter.get(member.tenant_id) ?? []), member.id]);
    return byCenter;
  }

  function validate(input) {
    const kind = String(input?.kind ?? '');
    const title = String(input?.title ?? '').trim();
    const body = String(input?.body ?? '').trim();
    const audience = String(input?.audience ?? '');
    const tenantId = audience === 'center' ? String(input?.tenantId ?? '') : null;
    if (!KINDS[kind] || (!title && !body) || title.length > 120 || body.length > 2000 || !AUDIENCES.includes(audience)) return null;
    if (audience === 'center' && !db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(tenantId)) return null;
    let survey = null;
    if (kind === 'survey') {
      const options = Array.isArray(input?.survey?.options) ? input.survey.options.map((option) => String(option).trim()).filter(Boolean) : [];
      survey = { options: options.slice(0, 8).map((option) => option.slice(0, 80)), rating: input?.survey?.rating === true, comment: input?.survey?.comment === true };
      // A survey asks something: a choice, a rating or a comment.
      if (survey.options.length === 1 || (!survey.options.length && !survey.rating && !survey.comment)) return null;
    }
    return { kind, title, body, audience, tenantId, survey };
  }

  /** How many people the message would reach, before it is sent. */
  function preview(input) {
    const message = validate({ kind: 'news', title: 'xxx', ...input });
    if (!message) return { kind: 'invalid' };
    const byCenter = recipients(message);
    return { kind: 'ok', recipients: [...byCenter.values()].reduce((sum, ids) => sum + ids.length, 0), centers: byCenter.size };
  }

  async function send(input) {
    const message = validate(input);
    if (!message) return { kind: 'invalid' };
    const byCenter = recipients(message);
    const id = `bc_${randomUUID()}`;
    const count = [...byCenter.values()].reduce((sum, ids) => sum + ids.length, 0);
    db.prepare(`INSERT INTO broadcasts (id, kind, title, body, audience, tenant_id, survey_json, sent_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, message.kind, message.title, message.body, message.audience, message.tenantId, message.survey ? JSON.stringify(message.survey) : null, count);
    const title = message.title ? `${KINDS[message.kind]} DetailFlow: ${message.title}` : `${KINDS[message.kind]} DetailFlow`;
    for (const [tenantId, memberIds] of byCenter) {
      await notifications.deliver(tenantId, memberIds, { kind: 'broadcast', title, body: message.body, link: null, broadcastId: id });
    }
    return { kind: 'sent', id, recipients: count };
  }

  function list() {
    return db.prepare(`SELECT b.id, b.kind, b.title, b.body, b.audience, b.created_at, b.sent_count, t.name AS center,
        (SELECT COUNT(*) FROM notifications n WHERE n.broadcast_id = b.id AND n.read_at IS NOT NULL) AS read_count,
        (SELECT COUNT(*) FROM broadcast_answers a WHERE a.broadcast_id = b.id) AS answers
      FROM broadcasts b LEFT JOIN tenants t ON t.id = b.tenant_id ORDER BY b.created_at DESC, b.rowid DESC LIMIT 100`).all()
      .map((row) => ({ id: row.id, kind: row.kind, title: row.title, excerpt: row.body.slice(0, 60), audience: row.audience, center: row.center, createdAt: row.created_at, sent: row.sent_count, read: row.read_count, answers: row.answers }));
  }

  /** A survey's results: the share of each option, the ratings, the comments with the center's name only. */
  function results(id) {
    const broadcast = db.prepare('SELECT id, kind, title, body, survey_json, sent_count, created_at FROM broadcasts WHERE id = ?').get(id);
    if (!broadcast) return null;
    const survey = broadcast.survey_json ? JSON.parse(broadcast.survey_json) : null;
    const answers = db.prepare(`SELECT a.option_index, a.rating, a.comment, a.answered_at, t.name AS center FROM broadcast_answers a
      JOIN tenants t ON t.id = a.tenant_id WHERE a.broadcast_id = ? ORDER BY a.answered_at DESC`).all(id);
    const ratings = answers.map((answer) => answer.rating).filter((rating) => rating !== null);
    return {
      id: broadcast.id, kind: broadcast.kind, title: broadcast.title, body: broadcast.body, survey, sent: broadcast.sent_count, createdAt: broadcast.created_at,
      answers: answers.length,
      options: survey?.options.map((label, index) => ({ label, count: answers.filter((answer) => answer.option_index === index).length })) ?? [],
      ratings: [1, 2, 3, 4, 5].map((value) => ({ value, count: ratings.filter((rating) => rating === value).length })),
      averageRating: ratings.length ? Math.round(ratings.reduce((sum, value) => sum + value, 0) / ratings.length * 10) / 10 : null,
      comments: answers.filter((answer) => answer.comment).map((answer) => ({ text: answer.comment, center: answer.center, at: answer.answered_at }))
    };
  }

  /** One answer per person, only to a survey they received. */
  function answer(tenantId, memberId, broadcastId, input) {
    const broadcast = db.prepare(`SELECT b.survey_json FROM broadcasts b JOIN notifications n ON n.broadcast_id = b.id
      WHERE b.id = ? AND b.kind = 'survey' AND n.member_id = ? LIMIT 1`).get(broadcastId, memberId);
    if (!broadcast) return { kind: 'not_found' };
    const survey = JSON.parse(broadcast.survey_json);
    const option = input?.option === null || input?.option === undefined ? null : Number(input.option);
    const rating = input?.rating === null || input?.rating === undefined ? null : Number(input.rating);
    const comment = String(input?.comment ?? '').trim().slice(0, 1000);
    if (option !== null && !(Number.isInteger(option) && option >= 0 && option < survey.options.length)) return { kind: 'invalid' };
    if (rating !== null && !(survey.rating && Number.isInteger(rating) && rating >= 1 && rating <= 5)) return { kind: 'invalid' };
    if (comment && !survey.comment) return { kind: 'invalid' };
    if (option === null && rating === null && !comment) return { kind: 'invalid' };
    const inserted = db.prepare(`INSERT OR IGNORE INTO broadcast_answers (broadcast_id, member_id, tenant_id, option_index, rating, comment) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(broadcastId, memberId, tenantId, option, rating, comment || null).changes;
    return inserted ? { kind: 'answered' } : { kind: 'already' };
  }

  /** Retention: survey answers are kept for a year. */
  function purge() {
    db.prepare(`DELETE FROM broadcast_answers WHERE answered_at < datetime('now', '-1 year')`).run();
  }

  return { recipients, preview, send, list, results, answer, purge };
}
