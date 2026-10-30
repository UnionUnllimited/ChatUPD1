import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnswers, pickServices } from '../server/lib/pick.js';

const vpn = (id, over = {}) => ({
  id, name: `VPN ${id}`, description: '', platforms: ['ios', 'android'], devices: 3, whitelist_bypass: false, payments: ['sbp'],
  min_monthly: 200, rating_rank: 4, popularity: 10, health: 'operational', trial: false, market: 'in', promo: null, top: null, ...over
});
const ask = (over = {}) => parseAnswers({ device: 'ios', devices: '1', whitelist: 'no', payment: 'any', budget: 'any', ...over });

test('answers are validated against the question list', () => {
  assert.throws(() => parseAnswers({ device: 'ios' }), /Ответьте/);
  assert.throws(() => parseAnswers({ device: 'nokia', devices: '1', whitelist: 'no', payment: 'any', budget: 'any' }), /Ответьте/);
  assert.equal(ask().device, 'ios');
});

test('hard requirements: platform, white lists and payment; outage is never recommended', () => {
  const items = [
    vpn(1, { platforms: ['android'] }),
    vpn(2, { whitelist_bypass: true, payments: ['card_ru'] }),
    vpn(3, { whitelist_bypass: true, payments: ['sbp', 'stars'] }),
    vpn(4, { whitelist_bypass: true, payments: ['sbp'], health: 'outage' })
  ];
  const r = pickServices(items, ask({ whitelist: 'yes', payment: 'sbp' }));
  assert.deepEqual(r.items.map((s) => s.id), [3]);
  assert.deepEqual(r.conditions, ['iPhone или iPad', 'обход белых списков', 'оплата: СБП']);
  assert.deepEqual(r.items[0].why, []); // nothing beyond the shared conditions
  assert.equal(r.catalog, 'platforms=ios&whitelist=1&payments=sbp');
});

test('ranking follows reviews and clients; issues push a service down', () => {
  const items = [vpn(1, { rating_rank: 3.5 }), vpn(2, { rating_rank: 4.8, popularity: 30 }), vpn(3, { rating_rank: 4.9, popularity: 30, health: 'issues' })];
  assert.deepEqual(pickServices(items, ask()).items.map((s) => s.id), [2, 1, 3]);
});

test('when nothing fits, the budget gives way first and the screen says so', () => {
  const items = [vpn(1, { min_monthly: 250 }), vpn(2, { min_monthly: 400 })];
  const r = pickServices(items, ask({ budget: '150' }));
  assert.deepEqual(r.relaxed, ['budget']);
  assert.equal(r.total, 2);
  assert.ok(!r.catalog.includes('price_max'));
  assert.ok(!r.conditions.some((c) => c.includes('₽')));
  // Payment is never relaxed: no match means an honest empty result.
  assert.equal(pickServices(items, ask({ payment: 'crypto' })).total, 0);
});
