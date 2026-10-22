import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { setupOwner } from '../server/setup.mjs';
import { AuthRepository } from '../server/auth-repository.mjs';
import { createBotDialog } from '../server/messenger/bot-dialog.mjs';

test('setup creates an empty center with an owner whose invite links the messenger account', async () => {
  const db = openDatabase(':memory:', { seed: false });
  const result = setupOwner(db, { centerName: 'Детейлинг на Ленина', ownerName: 'Мария Петрова', providers: ['telegram'] });
  assert.equal(result.kind, 'created');
  assert.deepEqual(result.member.roles, ['admin', 'owner']);
  assert.match(result.invites[0].code, /^invite_[0-9a-f]{24}$/);
  assert.equal(db.prepare('SELECT count(*) n FROM customers WHERE tenant_id = ?').get(result.tenant.id).n, 0, 'no demo data');

  const sent = [];
  const auth = new AuthRepository(db);
  const dialog = createBotDialog({ auth, adapters: new Map([['telegram', { sendMessage: async (to, text) => sent.push(text) }]]) });
  await dialog({ provider: 'telegram', kind: 'text', userId: '777', displayName: 'Мария', text: result.invites[0].code });
  assert.match(sent[0], /^Готово: аккаунт привязан./);
  assert.doesNotMatch(sent[0], /Мария|Ленина/, 'no names of people or centers go to the messenger');
  assert.equal(auth.membershipsFor('telegram', '777')[0].tenant.id, result.tenant.id);
  db.close();
});

test('setup refuses a duplicate center name and can add an owner to an existing center', () => {
  const db = openDatabase(':memory:', { seed: false });
  const first = setupOwner(db, { centerName: 'Центр', ownerName: 'Мария Петрова' });
  assert.equal(first.invites.length, 2, 'both messengers by default');
  const duplicate = setupOwner(db, { centerName: 'Центр', ownerName: 'Иван Иванов' });
  assert.equal(duplicate.kind, 'conflict');
  assert.match(duplicate.message, new RegExp(`--tenant ${first.tenant.id}`));
  assert.equal(db.prepare('SELECT count(*) n FROM tenants').get().n, 1);

  const recovered = setupOwner(db, { tenantId: first.tenant.id, ownerName: 'Иван Иванов', providers: ['max'] });
  assert.equal(recovered.kind, 'created');
  assert.equal(recovered.tenant.id, first.tenant.id);
  assert.equal(setupOwner(db, { tenantId: 'tenant_missing', ownerName: 'Иван Иванов' }).kind, 'not_found');
  assert.equal(setupOwner(db, { centerName: 'Другой', ownerName: 'И' }).kind, 'invalid');
  assert.equal(setupOwner(db, { centerName: 'Другой', ownerName: 'Иван Иванов', providers: ['sms'] }).kind, 'invalid');
  assert.equal(db.prepare('SELECT count(*) n FROM tenants').get().n, 1, 'invalid input creates nothing');
  db.close();
});
