/**
 * Persistence contract for the weighing cart.
 *
 * The storage choice is load-bearing and was wrong once already: sessionStorage
 * survives a reload but is destroyed with the WebView's browsing context, so the
 * Android case this code exists for (the OS killing the app mid-pour) was never
 * actually covered. These tests pin the two properties that matter together --
 * the cart outlives the browsing context, and a cart from a previous shift is
 * still discarded.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** Enough of the DOM for the module under test, and nothing more. */
class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number) {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

const local = new MemoryStorage();
const session = new MemoryStorage();

(globalThis as { window?: unknown }).window = {
  localStorage: local,
  sessionStorage: session,
};

const CART_KEY = 'koushi.cart';
const PAYLOAD_KEY = 'koushi.cart.pending-bill';

const { saveCart, loadCart, clearStoredCart, savePendingBill, loadPendingBill, clearPendingBill } =
  await import('../shared/cartStorage.ts');

const line = (over: Record<string, unknown> = {}) => ({
  uid: 'u1',
  id: 1,
  slug: 'maize',
  name: 'Maize',
  required: 50,
  status: 'completed' as const,
  actual: 50.4,
  ...over,
});

beforeEach(() => {
  local.clear();
  session.clear();
});

test('the cart is written to localStorage, not sessionStorage', () => {
  saveCart([line()], null);
  assert.notEqual(local.getItem(CART_KEY), null, 'must survive the browsing context');
  assert.equal(session.getItem(CART_KEY), null, 'sessionStorage does not survive an app kill');
});

test('a cart round trips with its completed line intact', () => {
  saveCart([line(), line({ uid: 'u2', name: 'Soya', actual: 25.1, status: 'completed' })], 7);
  const restored = loadCart();
  assert.equal(restored?.lines.length, 2);
  assert.equal(restored?.lines[1].name, 'Soya');
  assert.equal(restored?.lines[1].actual, 25.1);
  assert.equal(restored?.formulaId, 7);
});

test('a cart from a previous shift is discarded rather than mixed into today', () => {
  saveCart([line()], null);
  const stored = JSON.parse(local.getItem(CART_KEY)!) as { savedAt: number };
  // 13 hours later: a different day, and resuming it would merge two batches.
  stored.savedAt = Date.now() - 13 * 60 * 60 * 1000;
  local.setItem(CART_KEY, JSON.stringify(stored));
  assert.equal(loadCart(), null);
  assert.equal(local.getItem(CART_KEY), null, 'a stale cart must also be cleared, not just ignored');
});

test('a cart written before timestamps existed is not trusted', () => {
  local.setItem(CART_KEY, JSON.stringify({ formulaId: null, formulaName: null, lines: [line()] }));
  assert.equal(loadCart(), null);
});

test('a truncated or hand-edited cart is refused, not half restored', () => {
  // A cart that silently lost a line bills the operator for less than they weighed.
  for (const bad of [
    { lines: [{ uid: 'u1', name: 'Maize' }] }, // no required weight
    { lines: [{ uid: 'u1', name: '', required: 5, status: 'completed' }] }, // no name
    { lines: [{ uid: 'u1', name: 'Maize', required: 'fifty', status: 'completed' }] },
    { lines: [{ uid: 'u1', name: 'Maize', required: 5, status: 'invented' }] },
    { lines: [] },
    'not json at all',
  ]) {
    local.setItem(CART_KEY, JSON.stringify(bad));
    assert.equal(loadCart(), null, `${JSON.stringify(bad)} should be refused`);
  }
});

test('clearing the cart leaves nothing behind', () => {
  saveCart([line()], null);
  clearStoredCart();
  assert.equal(loadCart(), null);
});

test('a pending bill survives a reload and is offered for retry', () => {
  const payload = { weighedAt: '2026-09-27T14:30:00', formulaName: 'Layer 1', ref: 'abc123456', lines: [line()] };
  savePendingBill(payload);
  assert.equal(loadPendingBill<typeof payload>()?.ref, 'abc123456');
});

test('a pending bill with no usable lines is not offered as a bill', () => {
  // This drives the retry screen, so a malformed record must never reach the
  // save call as though it were a real weighing.
  savePendingBill({ ref: 'abc123456', lines: [] });
  assert.equal(loadPendingBill(), null);
  savePendingBill({ ref: 'abc123456', lines: 'nope' });
  assert.equal(loadPendingBill(), null);
  savePendingBill({ lines: [line()] });
  assert.equal(loadPendingBill(), null, 'no ref means no de-duplication, so it is not retried');
});

test('a pending bill older than a shift is dropped and cleared', () => {
  savePendingBill({ ref: 'abc123456', lines: [line()] });
  const stored = JSON.parse(local.getItem(PAYLOAD_KEY)!) as { savedAt: number };
  stored.savedAt = Date.now() - 13 * 60 * 60 * 1000;
  local.setItem(PAYLOAD_KEY, JSON.stringify(stored));
  assert.equal(loadPendingBill(), null);
  assert.equal(local.getItem(PAYLOAD_KEY), null);
});

test('clearing the pending bill leaves nothing behind', () => {
  savePendingBill({ ref: 'abc123456', lines: [line()] });
  clearPendingBill();
  assert.equal(loadPendingBill(), null);
});
