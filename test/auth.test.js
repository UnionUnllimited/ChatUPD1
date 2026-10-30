import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInitData, signInitData } from '../server/auth.js';

const TOKEN = '123456:TEST-token';
const user = JSON.stringify({ id: 42, first_name: 'Аня', username: 'anya' });

test('accepts correctly signed initData', () => {
  const now = 1_800_000_000;
  const data = signInitData({ user, auth_date: String(now - 60), query_id: 'AAH' }, TOKEN);
  const r = validateInitData(data, TOKEN, 3600, now);
  assert.equal(r.user.id, 42);
  assert.equal(r.user.first_name, 'Аня');
});

test('rejects a tampered payload', () => {
  const now = 1_800_000_000;
  const data = signInitData({ user, auth_date: String(now) }, TOKEN).replace('anya', 'evil');
  assert.equal(validateInitData(data, TOKEN, 3600, now), null);
});

test('rejects a signature made with another bot token', () => {
  const now = 1_800_000_000;
  const data = signInitData({ user, auth_date: String(now) }, 'other:token');
  assert.equal(validateInitData(data, TOKEN, 3600, now), null);
});

test('rejects stale initData', () => {
  const now = 1_800_000_000;
  const data = signInitData({ user, auth_date: String(now - 7200) }, TOKEN);
  assert.equal(validateInitData(data, TOKEN, 3600, now), null);
});

test('rejects garbage', () => {
  assert.equal(validateInitData('hash=zz&user=1', TOKEN, 3600), null);
  assert.equal(validateInitData('', TOKEN, 3600), null);
});
