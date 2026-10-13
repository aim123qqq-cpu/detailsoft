import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, normalizePlate } from '../server/domain/normalize.mjs';

test('normalizePhone keeps a stable international search key', () => {
  assert.equal(normalizePhone('+7 (913) 123-45-67'), '79131234567');
  assert.equal(normalizePhone('8 913 123 45 67'), '79131234567');
});

test('normalizePlate removes separators and uppercases without mixing alphabets', () => {
  assert.equal(normalizePlate('а 123 аа-55'), 'А123АА55');
  assert.equal(normalizePlate('a 123 aa-55'), 'A123AA55');
  assert.notEqual(normalizePlate('а123аа55'), normalizePlate('a123aa55'));
});
