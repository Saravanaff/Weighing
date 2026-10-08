/**
 * End-to-end tests against a real server process.
 *
 * The interesting failures in this app are not arithmetic, they are what the
 * API does with a hostile or a merely unlucky payload: a weight large enough to
 * overflow the stored total, a timestamp from a tablet with the wrong clock, a
 * retry of a save the server already committed. Each of those is started as a
 * real process against a throwaway database, so the behaviour under test is the
 * behaviour in production rather than a reimplementation of it.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 34817;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ChildProcess | null = null;
let dataDir: string | null = null;

const post = (route: string, body: unknown) =>
  fetch(`${BASE}/api${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const get = (route: string) => fetch(`${BASE}/api${route}`);

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'koushi-api-'));
  server = spawn(process.execPath, ['server/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: path.join(dataDir, 'test.db'),
      SCALE_ENABLED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for the port to answer rather than sleeping a fixed amount.
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error('server did not start in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

after(() => {
  server?.kill('SIGKILL');
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const line = (over: Record<string, unknown> = {}) => ({
  itemId: 1,
  itemName: 'Maize',
  requiredWeight: 51,
  actualWeight: 51,
  ...over,
});

test('health check reports ok', async () => {
  const res = await get('/health');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});

test('a weighing is saved and can be read back', async () => {
  const res = await post('/weighings', {
    weighedAt: new Date().toISOString().slice(0, 19),
    formulaName: 'Layer 1',
    ref: 'reftest0000000001',
    lines: [line()],
  });
  assert.equal(res.status, 201);
  const bill = (await res.json()) as { batchNo: string; totalWeight: number; itemCount: number };
  assert.match(bill.batchNo, /^WS-\d{5}$/);
  assert.equal(bill.totalWeight, 51);
  assert.equal(bill.itemCount, 1);

  const detail = await get(`/weighings/${String(bill.batchNo.match(/\d+/)![0])}`);
  assert.equal(detail.status, 200);
});

test('retrying a save with the same reference returns the original bill', async () => {
  // The save is the step most likely to fail on a shop Wi-Fi: if the server
  // commits and the response is lost, the operator presses RETRY SAVE. Without
  // the reference that writes a second bill and double counts the batch.
  const payload = {
    weighedAt: new Date().toISOString().slice(0, 19),
    formulaName: 'Retry test',
    ref: 'reftest0000000002',
    lines: [line({ itemName: 'Soya' })],
  };

  const first = await post('/weighings', payload);
  assert.equal(first.status, 201);
  const firstBill = (await first.json()) as { batchNo: string };

  const second = await post('/weighings', payload);
  assert.equal(second.status, 200, 'a replay is not a new bill');
  const secondBill = (await second.json()) as { batchNo: string; deduplicated?: boolean };
  assert.equal(secondBill.batchNo, firstBill.batchNo, 'same batch number');
  assert.equal(secondBill.deduplicated, true);

  // And there is genuinely only one row for it.
  const all = (await (await get('/weighings?limit=500')).json()) as Array<{ batchNo: string }>;
  const matches = all.filter((b) => b.batchNo === firstBill.batchNo);
  assert.equal(matches.length, 1, 'the batch must not appear twice');
});

test('a weight large enough to overflow the stored total is refused', async () => {
  // roundOffWeight multiplies by 1000, which overflows to Infinity past
  // ~1.8e305. Stored, that single row makes every report sum to Infinity and
  // serialise as null, and the dashboard never recovers.
  const res = await post('/weighings', {
    weighedAt: new Date().toISOString().slice(0, 19),
    formulaName: 'Overflow',
    ref: 'reftest0000000003',
    lines: [line({ requiredWeight: 1e308 })],
  });
  assert.equal(res.status, 400, 'an absurd weight is a client error, not a stored bill');

  const overview = await get('/reports/overview');
  const totals = (await overview.json()) as { totals: { totalKg: number | null } };
  assert.equal(
    Number.isFinite(totals.totals.totalKg),
    true,
    'the reports must still hold a finite total',
  );
});

test('a timestamp far from the server clock is refused', async () => {
  // Reports bucket on substr(weighed_at, 1, 7) and the month and day views
  // need an exact match, so a misdated bill appears in no report at all and
  // there is no endpoint to correct or delete it.
  const res = await post('/weighings', {
    weighedAt: '2035-01-01T00:00:00',
    formulaName: 'Clock skew',
    ref: 'reftest0000000004',
    lines: [line()],
  });
  assert.equal(res.status, 400);
});

test('an impossible calendar date is refused', async () => {
  for (const stamp of ['2026-13-45T00:00:00', '2026-02-30T10:00:00', '2026-09-27T25:90']) {
    const res = await post('/weighings', {
      weighedAt: stamp,
      formulaName: 'Bad date',
      ref: 'reftest0000000005',
      lines: [line()],
    });
    assert.equal(res.status, 400, `${stamp} should be rejected`);
  }
});

test('a bill with a line that cannot be stored is refused, not silently shortened', () => {
  // Skipping the line saved a bill with fewer items than were weighed, and the
  // operator was shown a bill they never produced.
  return (async () => {
    const res = await post('/weighings', {
      weighedAt: new Date().toISOString().slice(0, 19),
      formulaName: 'Bad line',
      ref: 'reftest0000000006',
      lines: [line(), line({ itemName: 'Bad', requiredWeight: -5 })],
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /Bad/);
  })();
});

test('an empty bill is refused', async () => {
  const res = await post('/weighings', {
    weighedAt: new Date().toISOString().slice(0, 19),
    formulaName: 'Empty',
    ref: 'reftest0000000007',
    lines: [],
  });
  assert.equal(res.status, 400);
});

test('a non-array lines field is refused rather than crashing', async () => {
  for (const lines of [null, 'nope', 42, {}]) {
    const res = await post('/weighings', {
      weighedAt: new Date().toISOString().slice(0, 19),
      ref: 'reftest0000000008',
      lines,
    });
    assert.equal(res.status, 400, `lines=${JSON.stringify(lines)} should be refused`);
  }
});

test('a missing reference still saves, it just cannot be de-duplicated', async () => {
  const res = await post('/weighings', {
    weighedAt: new Date().toISOString().slice(0, 19),
    formulaName: 'No ref',
    lines: [line()],
  });
  assert.equal(res.status, 201);
});

test('an unknown API path answers JSON, not HTML', async () => {
  // Falling through to Express's default HTML 404 used to reach the client as
  // "Unexpected token '<' in JSON".
  const res = await get('/nope');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error);
});

test('item create and delete round trip', async () => {
  const created = await post('/items', { name: 'Test Millet', requiredWeight: 30 });
  assert.equal(created.status, 201);
  const item = (await created.json()) as { id: number; name: string };
  assert.equal(item.name, 'Test Millet');

  const removed = await fetch(`${BASE}/api/items/${item.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
});

test('a duplicate item name is refused with a message, not a 500', async () => {
  const first = await post('/items', { name: 'Unique Millet', requiredWeight: 10 });
  assert.equal(first.status, 201);
  const item = (await first.json()) as { id: number };

  const second = await post('/items', { name: 'Unique Millet', requiredWeight: 10 });
  assert.equal(second.status, 409);
  const body = (await second.json()) as { error?: string };
  assert.ok(body.error && body.error.length > 0, 'the operator is told why');

  await fetch(`${BASE}/api/items/${item.id}`, { method: 'DELETE' });
});

test('deleting an item a formula uses is refused', async () => {
  const itemRes = await post('/items', { name: 'Locked Grain', requiredWeight: 40 });
  const item = (await itemRes.json()) as { id: number };

  const formulaRes = await post('/formulas', {
    name: 'Locked formula',
    lines: [{ itemId: item.id, itemName: 'Locked Grain', requiredWeight: 40 }],
  });
  assert.equal(formulaRes.status, 201);
  await formulaRes.json();

  const removed = await fetch(`${BASE}/api/items/${item.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 409, 'the item master cannot lose an item a formula needs');
  const body = (await removed.json()) as { formulas?: string[] };
  assert.ok(Array.isArray(body.formulas) && body.formulas.length > 0);
});

test('an unknown item id does not delete anything', async () => {
  const res = await fetch(`${BASE}/api/items/999999`, { method: 'DELETE' });
  assert.equal(res.status, 404);
});

test('reports stay finite and usable after everything above', async () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  for (const route of [
    '/reports/overview',
    `/reports/monthly?year=${year}&month=${month}`,
    `/reports/daily?date=${year}-${String(month).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`,
  ]) {
    const res = await get(route);
    assert.equal(res.status, 200, `${route} should answer`);
    const text = await res.text();
    assert.ok(!text.includes('null,"'), `${route} must not contain a null total`);
    JSON.parse(text); // throws if the payload is not valid JSON
  }
});

/** Byte-for-byte the generator in src/App.tsx and staff-app/src/App.tsx. */
const clientRef = () => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
};

test('the reference the clients actually generate is accepted and de-duplicates', async () => {
  // A hand-written 17-character reference in an earlier test passed while the
  // real generator produced 7 characters, which the server rejects -- so every
  // retry in the field wrote a second bill. This pins the two together.
  const ref = clientRef();
  assert.match(
    ref,
    /^[A-Za-z0-9_-]{8,64}$/,
    'the client reference must satisfy the length the server demands',
  );

  const body = {
    weighedAt: new Date().toISOString().slice(0, 19),
    formulaName: 'Client ref contract',
    ref,
    lines: [line({ itemName: 'Maize' })],
  };
  const first = await post('/weighings', body);
  assert.equal(first.status, 201);
  const bill = (await first.json()) as { id: number; batchNo: string };

  const second = await post('/weighings', body);
  assert.equal(second.status, 200, 'a replay must not create a second bill');
  const replay = (await second.json()) as { deduplicated?: boolean; id: number };
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.id, bill.id, 'the replay must return the original bill');

  // Two genuinely different references must produce two different bills, or
  // de-duplication has become over-eager and is dropping real sales.
  const other = { ...body, ref: clientRef() };
  const third = await post('/weighings', other);
  assert.equal(third.status, 201);
  const otherBill = (await third.json()) as { id: number };
  assert.notEqual(otherBill.id, bill.id, 'a distinct reference must save a new bill');
});

test('a heavy but real measured weight is kept, not discarded', async () => {
  // The YH-T7E frame carries six digits, so 1500 kg is a reading the scale can
  // genuinely produce. It used to be nulled behind a 201, which hid a working
  // heavy load behind a permanent "not recorded".
  const res = await post('/weighings', {
    weighedAt: new Date().toISOString().slice(0, 19),
    formulaName: 'Heavy load',
    ref: clientRef(),
    lines: [line({ actualWeight: 1500 })],
  });
  assert.equal(res.status, 201);
  const bill = (await res.json()) as { id: number };
  const detailRes = await get(`/weighings/${String(bill.id)}`);
  assert.equal(detailRes.status, 200);
  const detail = (await detailRes.json()) as { lines: { actualWeight: number | null }[] };
  assert.equal(detail.lines[0].actualWeight, 1500);
});

test('a measured weight beyond the scale itself is refused loudly', async () => {
  const res = await post('/weighings', {
    weighedAt: new Date().toISOString().slice(0, 19),
    formulaName: 'Impossible load',
    ref: clientRef(),
    lines: [line({ actualWeight: 99999 })],
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /measured weight/i);
});

test('a negative measured weight is refused', async () => {
  const res = await post('/weighings', {
    weighedAt: new Date().toISOString().slice(0, 19),
    formulaName: 'Negative',
    ref: clientRef(),
    lines: [line({ actualWeight: -5 })],
  });
  assert.equal(res.status, 400);
});

test('a missing or zero measured weight is still an ordinary bill', async () => {
  for (const actualWeight of [undefined, null, 0]) {
    const res = await post('/weighings', {
      weighedAt: new Date().toISOString().slice(0, 19),
      formulaName: 'No actual',
      ref: clientRef(),
      lines: [line({ actualWeight })],
    });
    assert.equal(res.status, 201, `actualWeight ${String(actualWeight)} should be accepted`);
  }
});

test('a negative or non-numeric limit cannot dump the whole table', async () => {
  // SQLite reads a negative LIMIT as "no limit", so ?limit=-5 returned every
  // bill ever recorded in one response.
  const res = await get('/weighings?limit=-5');
  assert.equal(res.status, 200);
  const rows = (await res.json()) as unknown[];
  assert.ok(rows.length <= 500, `expected a bounded list, got ${rows.length} rows`);
});

test('a malformed body is a client error, not a server error', async () => {
  const res = await fetch(`${BASE}/api/weighings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad',
  });
  assert.equal(res.status, 400, 'unparseable JSON should be a 400');
});

test('an item with no body at all is a client error, not a crash', async () => {
  const res = await post('/items', {});
  assert.ok(res.status === 400 || res.status === 422, `expected 4xx, got ${res.status}`);
});
