import test from 'node:test';
import assert from 'node:assert/strict';
import { randomId } from '../src/platform.ts';

test('randomId falls back to getRandomValues where randomUUID is missing (plain http on the local network)', () => {
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
  try {
    const ids = new Set(Array.from({ length: 50 }, () => randomId()));
    assert.equal(ids.size, 50);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    delete crypto.randomUUID;
  }
  assert.equal(typeof crypto.randomUUID, 'function');
  assert.match(randomId(), /^[0-9a-f-]{36}$/);
});
