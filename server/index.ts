import express, { type NextFunction, type Request, type Response } from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initDb, queryAll, queryOne, run } from './db.ts';
import {
  createScaleHttpHandlers,
  ScaleService,
  SUPPORTED_BAUD_RATES,
} from './scale/index.ts';
import {
  deleteItemAudio,
  downloadItemAudio,
  ensureTtsDirs,
  resolveNames,
  TTS_DIR,
} from './tts.ts';
import {
  decodeImageDataUrl,
  deleteItemImage,
  ensureItemImagesDir,
  ITEM_IMAGES_DIR,
  saveItemImage,
} from './itemImages.ts';
import { roundOffWeight, roundTargetWeight } from '../shared/targetWeight.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3001);
const PLC_SCRIPT = path.join(__dirname, 'plc_connection.py');
const PLC_CONFIG_FILE = path.join(__dirname, 'plc-config.json');

function loadPlcIp(): string {
  if (process.env.PLC_IP) return process.env.PLC_IP;
  try {
    const saved = JSON.parse(fs.readFileSync(PLC_CONFIG_FILE, 'utf8')) as { ip?: unknown };
    if (typeof saved.ip === 'string' && isIP(saved.ip) === 4) return saved.ip;
  } catch {
    // A missing or unreadable optional config uses the fixed default below.
  }
  return '192.168.250.1';
}

let plcIp = loadPlcIp();

function setPlcOutput(state: 'on' | 'off'): Promise<void> {
  return new Promise((resolve, reject) => {
    const pythonCommand = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const python = spawn(pythonCommand, [PLC_SCRIPT, state], {
      windowsHide: true,
      env: { ...process.env, PLC_IP: plcIp },
    });
    let error = '';
    python.stderr.on('data', (chunk: Buffer) => {
      error += chunk.toString();
    });
    python.on('error', reject);
    python.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(error.trim() || `PLC command exited with code ${code}`));
    });
  });
}

/**
 * Powers the machine off through the OS, mirroring how the kiosk's ESC exit
 * would end the day: Windows `shutdown /s /t 5` waits five seconds so the HTTP
 * response reaches the screen first; Linux uses `systemctl poweroff`.
 */
function requestSystemShutdown(): Promise<void> {
  return new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    const cmd = win ? 'shutdown' : 'systemctl';
    const args = win
      ? ['/s', '/t', '5', '/c', 'Naveen Farms terminal is shutting down.']
      : ['poweroff'];
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
      else resolve();
    });
  });
}

// app.listen throws synchronously on a bad port, before any handler above could
// report it: PORT=300O (letter O) or PORT=99999 took the process down with a raw
// stack and, since this runs at module load, before the serial port and SQLite
// handle were ever opened. Validated here so the operator gets a sentence
// instead.
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(
    `PORT must be a whole number between 1 and 65535, got ${JSON.stringify(process.env.PORT)}.`,
  );
  process.exit(1);
}

initDb();
ensureTtsDirs();
ensureItemImagesDir();

export const app = express();

// Hardening headers. A kiosk on a shop LAN, so no CDN, no cross-origin needs
// and nothing here should ever break the app when the API is same-origin.
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

// Cross-origin access is denied by default. The two browser clients are served
// from this same process in production, so nothing needs it. CORS_ORIGIN exists
// for the cases that genuinely cross origins, and accepts a single origin or a
// comma separated allowlist (never '*'):
//
//  - http://localhost, https://localhost   the Capacitor shells
//  - capacitor://localhost                  the iOS shell
//  - http://192.168.x.x:5173 etc. a client served by a different dev machine
//
// This is a browser-side control only: it does not stop a device on the LAN from
// calling the API directly, so it must not be mistaken for authentication.
const CORS_ALWAYS_ALLOWED = [
  'http://localhost',
  'https://localhost',
  'http://127.0.0.1',
  'https://127.0.0.1',
  'http://192.168.1.33',
  'capacitor://localhost',
];
const corsOrigins = [
  ...CORS_ALWAYS_ALLOWED,
  ...(process.env.CORS_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
];

/**
 * True when the browser origin may talk to the API.
 *
 * Loopback origins are compared without their port. The Android WebView always
 * runs at http://localhost, but the same app served in a browser comes from
 * http://localhost:3001, and Chrome sends an Origin header even on a same-origin
 * POST. Treating those as different origins would let the API read fine and then
 * reject every write from the browser, which looks like a server fault rather
 * than a rejected origin. The port is not a security boundary on a device that
 * is already only reachable from the shop LAN.
 */
const isAllowedOrigin = (origin: string): boolean => {
  if (corsOrigins.includes(origin)) return true;
  const match = /^([a-z][a-z0-9+.-]*):\/\/(\[[0-9a-f:.]+\]|(?:localhost|127\.0\.0\.1|\[::1\]))(?::\d{1,5})?$/i.exec(
    origin,
  );
  if (!match) return false;
  return CORS_ALWAYS_ALLOWED.includes(`${match[1].toLowerCase()}://${match[2].toLowerCase()}`);
};

// This must stay enabled: the Android app is a genuinely cross-origin client.
// Its WebView runs at http://localhost and calls the API at the LAN address
// typed into ServerScreen, so without these headers the WebView blocks every
// response and the app can never reach the server — while curl and the Vite dev
// clients (proxied, therefore same-origin) work fine and hide the problem.
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  if (!isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Item photos arrive as data: URLs, which are far larger than the JSON bodies
// the rest of the API accepts. This parser is registered before the global one
// below so the big body is not rejected with a 413 before it gets here.
app.post('/api/items/:id/image', express.json({ limit: '8mb' }));

app.use(express.json({ limit: '256kb' }));
app.use('/tts', (req, res, next) => {
  // The voice clips are fetched from the same server by the Android WebView,
  // so they need the same origin allowance as the API.
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  next();
});
app.use(
  '/tts',
  express.static(TTS_DIR, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }),
);
app.use(
  '/item-images',
  express.static(ITEM_IMAGES_DIR, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }),
);

/** An error carrying an HTTP status, so handlers can bail out with one. */
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

const httpError = (status: number, message: string): HttpError => new HttpError(status, message);

const errorStatus = (err: unknown, fallback: number): number =>
  err instanceof HttpError ? err.status : fallback;

const errorMessage = (err: unknown, fallback: string): string =>
  err instanceof Error ? err.message : fallback;

/**
 * Plausible bounds for any weight the server will accept, in kilograms.
 *
 * A finite but absurd number is worse than a rejected one. roundOffWeight
 * multiplies by 1000 before flooring, so a value above ~1.8e305 overflows that
 * product to Infinity and the stored total becomes Inf. Every report then sums
 * to Infinity, JSON renders it as null, and the dashboard is dead permanently
 * from a single row. Bounding the input keeps that unreachable.
 */
const MIN_WEIGHT_KG = 0;
const MAX_WEIGHT_KG = 1000;
/**
 * The YH-T7E frame carries six digit characters, so a reading such as 9999.9 kg
 * is representable. A target above a tonne is a typo, but a *measured* weight
 * above it is a real sack of maize, so the two need different ceilings.
 */
const MAX_ACTUAL_WEIGHT_KG = 10000;

const parseOptionalWeight = (value: unknown): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < MIN_WEIGHT_KG || n > MAX_WEIGHT_KG) return null;
  return n;
};

/** Same guard, against the scale's own ceiling rather than the target's. */
const parseActualWeight = (value: unknown): number | null => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < MIN_WEIGHT_KG || n > MAX_ACTUAL_WEIGHT_KG) return null;
  return n;
};

/** `YYYY-MM-DDTHH:MM` with an optional `:SS`, matching localIsoNow(). */
const WEIGHED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/**
 * How far a client's clock may disagree with the server's before the timestamp
 * is refused. Reports bucket on substr(weighed_at, 1, 7) and the month and day
 * views require an exact match, so a bill dated three years out appears in no
 * report at all and cannot be deleted or corrected. A tablet with a wrong
 * clock is a routine thing on a farm network, so this is a wide but finite
 * window rather than no check at all.
 */
const WEIGHED_AT_SKEW_MS = 36 * 60 * 60 * 1000;

/**
 * Normalises a client-supplied timestamp, or returns null when it is not a
 * usable date. Every report buckets on substr(weighed_at, 1, 7), so a junk
 * value here permanently removes a bill from its month.
 */
const normalizeWeighedAt = (value: unknown): string | null => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const stamp = raw.slice(0, 19);
  if (!WEIGHED_AT_PATTERN.test(stamp)) return null;
  // Reject impossible calendar values such as 2026-13-45 or 25:90.
  const [datePart, timePart] = stamp.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm, ss] = timePart.split(':').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  const parsed = new Date(y, m - 1, d, hh, mm, ss);
  if (
    parsed.getFullYear() !== y ||
    parsed.getMonth() + 1 !== m ||
    parsed.getDate() !== d
  ) {
    return null;
  }
  // Compare against the clock as it is right now, not against the moment this
  // module happened to be loaded. A const captured at boot turns the window
  // into "uptime must be under 36h" and silently stops every save on day two.
  if (Math.abs(parsed.getTime() - Date.now()) > WEIGHED_AT_SKEW_MS) return null;
  return stamp;
};

// ---------- Row shapes returned by SQLite ----------

interface ItemRow {
  id: number;
  slug: string;
  code: string;
  name: string;
  name_hi: string;
  name_bn: string;
  name_ta: string;
  created_at: string;
  /** Path of the item photo, or null when the item has no picture. */
  image_path: string | null;
}

interface FormulaRow {
  id: number;
  name: string;
  item_count: number;
  total_weight: number;
  created_at: string;
}

interface FormulaLineRow {
  id: number;
  formulaId: number;
  itemId: number | null;
  itemName: string;
  requiredWeight: number;
  position: number;
}

interface WeighingRow {
  id: number;
  batch_no: string;
  weighed_at: string;
  formula_name: string | null;
  item_count: number;
  total_weight: number;
}

interface WeighingLineRow {
  id: number;
  weighing_id: number;
  item_id: number | null;
  item_name: string;
  required_weight: number;
  actual_weight: number | null;
}

interface CountRow {
  n: number;
}

interface CodeRow {
  code: string;
}

interface OverviewTotalsRow {
  bills: number;
  items: number;
  totalKg: number;
}

interface MonthBucketRow {
  month: string;
  bills: number;
  items: number;
  totalKg: number;
}

interface PerItemRow {
  itemName: string;
  times: number;
  totalKg: number;
}

interface PerFormulaRow {
  formulaName: string;
  bills: number;
  totalKg: number;
}

interface FormulaLineInput {
  itemId: number;
  itemName: string;
  requiredWeight: number;
}

interface WeighingLineInput {
  itemId: number | null;
  itemName: string;
  requiredWeight: number;
  /** Measured weight, when the client captured one. Null = not recorded. */
  actualWeight: number | null;
}

const MAX_NAME_LENGTH = 60;
const MAX_NATIVE_LENGTH = 60;
const MAX_FORMULA_LINES = 80;

const NATIVE_FIELD_LABELS = {
  name_hi: 'Hindi name',
  name_bn: 'Bengali name',
  name_ta: 'Tamil name',
};

const cleanName = (value: unknown, label: string): string => {
  const name = String(value || '').trim();
  if (!name) throw httpError(400, `${label} is required`);
  if (name.length > MAX_NAME_LENGTH) {
    throw httpError(400, `${label} must be ${MAX_NAME_LENGTH} characters or fewer`);
  }
  return name;
};

app.get('/api/health', (_req, res) => {
  try {
    db.prepare('SELECT 1 AS ok').get();
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, db: 'error' });
  }
});

app.post('/api/plc/output', async (req, res) => {
  const state = req.body?.state;
  if (state !== 'on' && state !== 'off') {
    return res.status(400).json({ error: 'state must be on or off' });
  }
  try {
    await setPlcOutput(state);
    return res.json({ ok: true, state });
  } catch (err) {
    console.error(`PLC output ${state} failed:`, err);
    return res.status(502).json({ error: err instanceof Error ? err.message : 'PLC command failed' });
  }
});

app.get('/api/plc/config', (_req, res) => {
  res.json({ ip: plcIp });
});

app.put('/api/plc/config', (req, res) => {
  const ip = String(req.body?.ip || '').trim();
  if (isIP(ip) !== 4) {
    return res.status(400).json({ error: 'PLC IP must be a valid IPv4 address' });
  }
  plcIp = ip;
  fs.writeFileSync(PLC_CONFIG_FILE, `${JSON.stringify({ ip: plcIp }, null, 2)}\n`, 'utf8');
  return res.json({ ip: plcIp });
});

// ---------------------------------------------------------------------------
// System power-off (the kiosk SHUTDOWN button in both terminals).
// POST /api/shutdown turns the machine off. A weighing terminal is exactly
// where an accidental tap is dangerous, so the client sends confirm:true only
// after the operator taps a second time, and the OS waits a few seconds after
// the reply before actually going down. `dryRun` lets the API tests exercise
// the guard without powering off the machine running them.
// ---------------------------------------------------------------------------
app.post('/api/shutdown', async (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Shutdown requires the terminal to confirm it first' });
  }
  if (req.body?.dryRun === true) {
    return res.json({ ok: true, dryRun: true });
  }
  try {
    await requestSystemShutdown();
    return res.json({ ok: true });
  } catch (err) {
    console.error('System shutdown failed:', err);
    return res
      .status(502)
      .json({ error: err instanceof Error ? err.message : 'System shutdown failed' });
  }
});

// ---------------------------------------------------------------------------
// Weighing scale (YH-T7E / YAOHUA over serial).
// SCALE_ENABLED=0 keeps the reader dormant so the API can still serve the item
// master and reports on a machine with no scale wired up. Weighing itself needs
// the scale, so a client pointed at such a server will report the scale offline
// rather than accepting anything.
// ---------------------------------------------------------------------------
const scaleEnabled = process.env.SCALE_ENABLED !== '0';
const scale = new ScaleService();
const scaleHandlers = createScaleHttpHandlers(scale);
if (scaleEnabled) scale.start();

app.get('/api/scale/ports', async (_req, res) => {
  const ports = await scale.listPorts().catch((err) => {
    console.error('Serial port discovery failed:', err);
    return [];
  });
  res.json({
    enabled: scaleEnabled,
    port: scale.getStatus().port,
    ports,
    baudRates: SUPPORTED_BAUD_RATES,
    current: scale.getStatus(),
  });
});

app.get('/api/scale/status', scaleHandlers.status);
app.get('/api/scale/stream', scaleHandlers.stream);

app.post('/api/scale/connect', async (req, res) => {
  if (!scaleEnabled) throw httpError(503, 'Scale support is disabled (SCALE_ENABLED=0)');
  const { port, baudRate } = (req.body || {}) as { port?: string; baudRate?: number };
  if (baudRate != null && !SUPPORTED_BAUD_RATES.includes(Number(baudRate))) {
    throw httpError(400, `Unsupported baud rate. Use one of: ${SUPPORTED_BAUD_RATES.join(', ')}`);
  }
  if (port != null && String(port).trim() === '') {
    throw httpError(400, 'Serial port is required');
  }
  const status = await scale.configure({ portPath: port, baudRate });
  if (!scale.isRunning) scale.start();
  res.json(status);
});

app.post('/api/scale/disconnect', (_req, res) => {
  scale.stop();
  res.json(scale.getStatus());
});

const toItemJson = (row: ItemRow) => ({
  id: row.id,
  slug: row.slug,
  code: row.code,
  name: row.name,
  names: { en: row.name, hi: row.name_hi, bn: row.name_bn, ta: row.name_ta },
  imagePath: row.image_path || null,
  createdAt: row.created_at,
});

app.get('/api/items', (_req, res) => {
  res.json(queryAll<ItemRow>('SELECT * FROM items ORDER BY code ASC, name ASC').map(toItemJson));
});

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'item';

app.post('/api/items', async (req, res) => {
  const body = req.body || {};
  const name = cleanName(body.name, 'Item name');

  for (const [field, label] of Object.entries(NATIVE_FIELD_LABELS)) {
    const val = String(body[field] || '').trim();
    if (val.length > MAX_NATIVE_LENGTH) {
      return res.status(400).json({ error: `${label} must be ${MAX_NATIVE_LENGTH} characters or fewer` });
    }
  }

  const existing = queryOne<CountRow>('SELECT COUNT(*) AS n FROM items WHERE name = ?', name);
  if (Number(existing?.n ?? 0) > 0) {
    return res.status(409).json({ error: `Item "${name}" already exists` });
  }

  const nextCodeRow = queryOne<CodeRow>(
    "SELECT code FROM items WHERE code LIKE 'RM-%' ORDER BY code DESC LIMIT 1",
  );
  const nextNum = nextCodeRow ? parseInt(nextCodeRow.code.slice(3), 10) + 1 : 1;
  const code = `RM-${String(nextNum).padStart(2, '0')}`;

  let slug = slugify(name);
  const slugExists = queryOne<CountRow>('SELECT COUNT(*) AS n FROM items WHERE slug = ?', slug);
  if (Number(slugExists?.n ?? 0) > 0) slug = `${slug}-${nextNum}`;

  let names: { hi: string; bn: string; ta: string };
  try {
    names = await resolveNames(name, {
      hi: req.body.name_hi,
      bn: req.body.name_bn,
      ta: req.body.name_ta,
    });
  } catch (err) {
    console.warn('name resolution failed, using English: ' + errorMessage(err, 'unknown error'));
    names = { hi: name, bn: name, ta: name };
  }

  const info = run(
    'INSERT INTO items (slug, code, name, name_hi, name_bn, name_ta) VALUES (?, ?, ?, ?, ?, ?)',
    slug,
    code,
    name,
    names.hi,
    names.bn,
    names.ta,
  );
  const row = queryOne<ItemRow>('SELECT * FROM items WHERE id = ?', info.lastInsertRowid);

  try {
    await downloadItemAudio(slug, { en: name, ...names });
  } catch (err) {
    console.warn('item audio download failed: ' + errorMessage(err, 'unknown error'));
  }

  res.status(201).json(toItemJson(row as ItemRow));
});

/**
 * Attaches (or replaces) an item photo. The bytes are written to
 * server/storage/item-images and only the resulting path goes into the row, so
 * the database never stores image data.
 */
app.post('/api/items/:id/image', (req, res) => {
  const id = Number(req.params.id);
  const row = queryOne<ItemRow>('SELECT * FROM items WHERE id = ?', id);
  if (!row) {
    return res.status(404).json({ error: 'Item not found' });
  }

  let stored: { bytes: Buffer; ext: string };
  try {
    stored = decodeImageDataUrl((req.body || {}).dataUrl);
  } catch (err) {
    return res.status(400).json({ error: errorMessage(err, 'Invalid image') });
  }

  const imagePath = saveItemImage(row.slug, stored.bytes, stored.ext);
  try {
    run('UPDATE items SET image_path = ? WHERE id = ?', imagePath, id);
  } catch (err) {
    // Nothing will ever point at the file we just wrote, and nothing sweeps the
    // directory, so a failed UPDATE would leak 4MB per attempt until the card fills.
    deleteItemImage(imagePath);
    throw err;
  }
  // Only drop the old picture once the new one is safely on disk, so a failed
  // upload never leaves the item with no picture at all.
  if (row.image_path) deleteItemImage(row.image_path);

  const updated = queryOne<ItemRow>('SELECT * FROM items WHERE id = ?', id);
  res.json(toItemJson(updated as ItemRow));
});

/** Clears the item photo and deletes the file it pointed at. */
app.delete('/api/items/:id/image', (req, res) => {
  const id = Number(req.params.id);
  const row = queryOne<ItemRow>('SELECT * FROM items WHERE id = ?', id);
  if (!row) {
    return res.status(404).json({ error: 'Item not found' });
  }
  run('UPDATE items SET image_path = NULL WHERE id = ?', id);
  deleteItemImage(row.image_path);
  res.json(toItemJson(queryOne<ItemRow>('SELECT * FROM items WHERE id = ?', id) as ItemRow));
});

app.delete('/api/items/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = queryOne<{ slug: string; image_path: string | null }>(
    'SELECT slug, image_path FROM items WHERE id = ?',
    id,
  );
  if (!row) {
    return res.status(404).json({ error: 'Item not found' });
  }

  // Deleting an item used to leave formula_lines pointing at a row that no
  // longer exists, so the formula showed a line with no item behind it. Past
  // bills keep their own item_name snapshot, so refusing here is safe.
  const usedBy = queryAll<{ name: string }>(
    'SELECT f.name AS name FROM formula_lines fl JOIN formulas f ON f.id = fl.formula_id WHERE fl.item_id = ? ORDER BY f.name',
    id,
  );
  if (usedBy.length > 0) {
    const preview = usedBy.slice(0, 3).map((f) => f.name);
    return res.status(409).json({
      error: `This item is used by ${usedBy.length} formula${usedBy.length === 1 ? '' : 's'} (${preview.join(', ')}${usedBy.length > 3 ? ', …' : ''}). Delete or update those formulas first.`,
      formulas: usedBy.map((f) => f.name),
    });
  }

  run('DELETE FROM items WHERE id = ?', id);
  deleteItemAudio(row.slug);
  // The photo file outlives the row unless it is removed with it, otherwise
  // server/storage/item-images slowly fills up with orphans.
  deleteItemImage(row.image_path);
  res.json({ ok: true });
});

// ---------- Formulas ----------

const toFormulaJson = (row: FormulaRow, lines: FormulaLineRow[]) => ({
  id: row.id,
  name: row.name,
  itemCount: row.item_count,
  totalWeight: row.total_weight,
  createdAt: row.created_at,
  lines,
});

const parseFormulaBody = (body: Record<string, unknown>) => {
  const name = cleanName(body.name, 'Formula name');

  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  const lines: FormulaLineInput[] = [];
  const seenItems = new Set<number>();
  for (const raw of rawLines) {
    if (lines.length >= MAX_FORMULA_LINES) break;
    const itemId = Number(raw.itemId);
    const requiredWeight = parseOptionalWeight(raw.requiredWeight);
    if (!Number.isInteger(itemId) || itemId <= 0) continue;
    if (requiredWeight == null || requiredWeight <= 0) continue;
    if (seenItems.has(itemId)) continue;
    seenItems.add(itemId);
    const item = queryOne<{ id: number; name: string }>(
      'SELECT id, name FROM items WHERE id = ?',
      itemId,
    );
    if (!item) continue;
    lines.push({
      itemId,
      itemName: item.name,
      requiredWeight: roundTargetWeight(requiredWeight),
    });
  }
  if (lines.length === 0) {
    throw httpError(400, 'Formula needs at least one valid ingredient with a weight above zero');
  }
  return { name, lines };
};

const formulaLinesSql =
  'SELECT id, formula_id AS formulaId, item_id AS itemId, item_name AS itemName, required_weight AS requiredWeight, position FROM formula_lines WHERE formula_id = ? ORDER BY position ASC';

const formulaLinesInsertSql =
  'INSERT INTO formula_lines (formula_id, item_id, item_name, required_weight, position) VALUES (?, ?, ?, ?, ?)';

app.get('/api/formulas', (_req, res) => {
  const rows = queryAll<FormulaRow>('SELECT * FROM formulas ORDER BY name ASC');
  const lineRows = queryAll<FormulaLineRow>(
    'SELECT id, formula_id AS formulaId, item_id AS itemId, item_name AS itemName, required_weight AS requiredWeight, position FROM formula_lines ORDER BY formula_id ASC, position ASC',
  );
  const byFormula = new Map<number, FormulaLineRow[]>();
  for (const line of lineRows) {
    const key = Number(line.formulaId);
    if (!byFormula.has(key)) byFormula.set(key, []);
    byFormula.get(key)?.push(line);
  }
  res.json(rows.map((row) => toFormulaJson(row, byFormula.get(Number(row.id)) || [])));
});

app.post('/api/formulas', (req, res) => {
  let parsed: { name: string; lines: FormulaLineInput[] };
  try {
    parsed = parseFormulaBody(req.body ?? {});
  } catch (err) {
    return res.status(errorStatus(err, 400)).json({ error: errorMessage(err, 'Invalid formula') });
  }

  const existing = queryOne<CountRow>('SELECT COUNT(*) AS n FROM formulas WHERE name = ?', parsed.name);
  if (Number(existing?.n ?? 0) > 0) {
    return res.status(409).json({ error: `Formula "${parsed.name}" already exists` });
  }

  const itemCount = parsed.lines.length;
  const totalWeight =
    Math.round(parsed.lines.reduce((sum, line) => sum + line.requiredWeight, 0) * 1000) / 1000;

  const insertFormulaSql = 'INSERT INTO formulas (name, item_count, total_weight) VALUES (?, ?, ?)';
  const insertLineSql =
    'INSERT INTO formula_lines (formula_id, item_id, item_name, required_weight, position) VALUES (?, ?, ?, ?, ?)';

  db.exec('BEGIN');
  let committed = false;
  try {
    const info = run(insertFormulaSql, parsed.name, itemCount, totalWeight);
    const formulaId = Number(info.lastInsertRowid);
    parsed.lines.forEach((line, index) =>
      run(insertLineSql, formulaId, line.itemId, line.itemName, line.requiredWeight, index),
    );
    db.exec('COMMIT');
    committed = true;
    const row = queryOne<FormulaRow>('SELECT * FROM formulas WHERE id = ?', formulaId);
    res.status(201).json(
      toFormulaJson(
        row as FormulaRow,
        parsed.lines.map((line, index) => ({ id: index, formulaId, ...line, position: index })),
      ),
    );
  } catch (err) {
    // Rolling back a transaction that already committed throws in better-sqlite3
    // and would bury the real error under "no transaction is active".
    if (!committed) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // already closed
      }
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to save formula' });
  }
});

app.put('/api/formulas/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!queryOne<{ id: number }>('SELECT id FROM formulas WHERE id = ?', id)) {
    return res.status(404).json({ error: 'Formula not found' });
  }

  let parsed: { name: string; lines: FormulaLineInput[] };
  try {
    parsed = parseFormulaBody(req.body ?? {});
  } catch (err) {
    return res.status(errorStatus(err, 400)).json({ error: errorMessage(err, 'Invalid formula') });
  }

  const nameDup = queryOne<CountRow>(
    'SELECT COUNT(*) AS n FROM formulas WHERE name = ? AND id != ?',
    parsed.name,
    id,
  );
  if (Number(nameDup?.n ?? 0) > 0) {
    return res.status(409).json({ error: `Formula "${parsed.name}" already exists` });
  }

  const itemCount = parsed.lines.length;
  const totalWeight =
    Math.round(parsed.lines.reduce((sum, line) => sum + line.requiredWeight, 0) * 1000) / 1000;

  db.exec('BEGIN');
  let committed = false;
  try {
    run(
      'UPDATE formulas SET name = ?, item_count = ?, total_weight = ? WHERE id = ?',
      parsed.name,
      itemCount,
      totalWeight,
      id,
    );
    run('DELETE FROM formula_lines WHERE formula_id = ?', id);
    parsed.lines.forEach((line, index) =>
      run(
        formulaLinesInsertSql,
        id,
        line.itemId,
        line.itemName,
        line.requiredWeight,
        index,
      ),
    );
    db.exec('COMMIT');
    committed = true;
    const row = queryOne<FormulaRow>('SELECT * FROM formulas WHERE id = ?', id);
    res.json(
      toFormulaJson(
        row as FormulaRow,
        queryAll<FormulaLineRow>(formulaLinesSql, id),
      ),
    );
  } catch (err) {
    if (!committed) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // already closed
      }
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to update formula' });
  }
});

app.delete('/api/formulas/:id', (req, res) => {
  const info = run('DELETE FROM formulas WHERE id = ?', Number(req.params.id));
  if (info.changes === 0) {
    return res.status(404).json({ error: 'Formula not found' });
  }
  res.json({ ok: true });
});

// ---------- Weighings (bills) ----------

const pad = (n: number) => String(n).padStart(2, '0');
const localIsoNow = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

app.post('/api/weighings', (req, res) => {
  const body = req.body || {};
  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (rawLines.length > MAX_FORMULA_LINES) {
    return res
      .status(400)
      .json({ error: `A bill can hold at most ${MAX_FORMULA_LINES} line items` });
  }
  const lines: WeighingLineInput[] = [];
  for (const raw of rawLines) {
    const itemId = Number.isFinite(Number(raw.itemId)) ? Math.floor(Number(raw.itemId)) : null;
    const name = String(raw.itemName || '').trim() || 'Item';
    const weight = parseOptionalWeight(raw.requiredWeight);
    const actual = parseActualWeight(raw.actualWeight);
    // A measured weight is optional, and "not weighed" is a normal bill. But a
    // reading that was sent and is out of range is a real fault, and recording
    // it as "not recorded" would hide a broken scale behind a 201 forever.
    if (
      raw.actualWeight != null &&
      raw.actualWeight !== '' &&
      Number.isFinite(Number(raw.actualWeight)) &&
      actual == null
    ) {
      return res.status(400).json({
        error: `"${name}" reports a measured weight of ${JSON.stringify(raw.actualWeight)} kg, which is outside the ${MAX_ACTUAL_WEIGHT_KG} kg the scale can read`,
      });
    }
    // A line that cannot be stored is refused rather than skipped. Silently
    // dropping it saved a bill with fewer lines than were actually weighed, and
    // the operator was shown a bill they never produced.
    if (weight == null || weight <= 0 || roundTargetWeight(weight) <= 0) {
      return res.status(400).json({
        error: `"${name}" has a required weight of ${JSON.stringify(raw.requiredWeight)} kg, which is not a usable weight`,
      });
    }
    lines.push({
      itemId,
      itemName: name.slice(0, MAX_NAME_LENGTH),
      requiredWeight: roundTargetWeight(weight),
      // Rounded like the target, so a bill shows the same whole kilograms the
      // operator was shown when the line was accepted. A measured weight that
      // floors to nothing is recorded as "not recorded" rather than as a
      // misleading 0.000, which is indistinguishable from a real empty pan.
      actualWeight:
        actual != null && actual > 0 && roundOffWeight(actual) > 0 ? roundOffWeight(actual) : null,
    });
  }
  if (lines.length === 0) {
    return res.status(400).json({
      error: 'A completed weighing needs at least one line item with a weight above zero',
    });
  }

  const itemCount = lines.length;
  const totalWeight = lines.reduce((sum, line) => sum + line.requiredWeight, 0);
  // weighed_at is the axis every report groups on, so a malformed value would
  // silently drop a bill out of its month forever. Accept only a real
  // YYYY-MM-DDTHH:MM[:SS] stamp (or an ISO string we can truncate to one).
  const weighedAt =
    (body.weighedAt ? normalizeWeighedAt(body.weighedAt) : localIsoNow()) || null;
  if (!weighedAt) {
    return res
      .status(400)
      .json({ error: 'weighedAt must look like 2026-09-27T14:30 (YYYY-MM-DDTHH:MM:SS)' });
  }
  const formulaName = String(body.formulaName || '').trim().slice(0, MAX_NAME_LENGTH) || null;

  // The client generates this once per weighing and repeats it on a retry, so
  // a replay of an already-saved batch returns the original bill instead of
  // creating a second one.
  const clientRef = /^[A-Za-z0-9_-]{8,64}$/.test(String(body.ref ?? ''))
    ? String(body.ref)
    : null;
  if (clientRef) {
    const existing = queryOne<WeighingRow>(
      'SELECT * FROM weighings WHERE client_ref = ?',
      clientRef,
    );
    if (existing) {
      const storedLines = queryAll<Omit<WeighingLineRow, 'weighing_id'>>(
        'SELECT id, item_id AS itemId, item_name AS itemName, required_weight AS requiredWeight, actual_weight AS actualWeight FROM weighing_lines WHERE weighing_id = ? ORDER BY id ASC',
        existing.id,
      );
      return res
        .status(200)
        .json({ ...toBillJson(existing), lines: storedLines, deduplicated: true });
    }
  }

  const insertWeighingSql =
    'INSERT INTO weighings (batch_no, weighed_at, item_count, total_weight, formula_name, client_ref) VALUES (?, ?, ?, ?, ?, ?)';
  const insertLineSql =
    'INSERT INTO weighing_lines (weighing_id, item_id, item_name, required_weight, actual_weight) VALUES (?, ?, ?, ?, ?)';

  let committed = false;
  db.exec('BEGIN');
  try {
    const info = run(insertWeighingSql, '', weighedAt, itemCount, Math.round(totalWeight * 1000) / 1000, formulaName, clientRef);
    const id = Number(info.lastInsertRowid);
    const batchNo = `WS-${String(id).padStart(5, '0')}`;
    run('UPDATE weighings SET batch_no = ? WHERE id = ?', batchNo, id);
    for (const line of lines) {
      run(insertLineSql, id, line.itemId, line.itemName, line.requiredWeight, line.actualWeight ?? null);
    }
    db.exec('COMMIT');
    committed = true;
    const bill = queryOne<WeighingRow>('SELECT * FROM weighings WHERE id = ?', id);
    res.status(201).json({ ...toBillJson(bill as WeighingRow), lines });
  } catch (err) {
    // Only roll back a transaction that is still open. Rolling back after the
    // COMMIT throws "no transaction is active", which replaced the real error
    // with a confusing one and hid what actually went wrong.
    if (!committed) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Already rolled back or never started; nothing to undo.
      }
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to save weighing' });
  }
});

const toBillJson = (row: WeighingRow) => ({
  id: row.id,
  batchNo: row.batch_no,
  weighedAt: row.weighed_at,
  formulaName: row.formula_name || null,
  itemCount: row.item_count,
  totalWeight: row.total_weight,
});

app.get('/api/weighings', (req, res) => {
  // SQLite reads a negative LIMIT as "no limit at all", so the floor matters.
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));
  const rows = queryAll<WeighingRow>(
    'SELECT * FROM weighings ORDER BY weighed_at DESC, id DESC LIMIT ?',
    limit,
  );
  res.json(rows.map(toBillJson));
});

app.get('/api/weighings/:id', (req, res) => {
  const bill = queryOne<WeighingRow>('SELECT * FROM weighings WHERE id = ?', Number(req.params.id));
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  const lines = queryAll<Omit<WeighingLineRow, 'weighing_id'>>(
    'SELECT id, item_id AS itemId, item_name AS itemName, required_weight AS requiredWeight, actual_weight AS actualWeight FROM weighing_lines WHERE weighing_id = ? ORDER BY id ASC',
    bill.id,
  );
  res.json({ ...toBillJson(bill), lines });
});

// ---------- Reports ----------

app.get('/api/reports/overview', (_req, res) => {
  const totals = queryOne<OverviewTotalsRow>(
    'SELECT COUNT(*) AS bills, COALESCE(SUM(item_count), 0) AS items, ROUND(COALESCE(SUM(total_weight), 0), 3) AS totalKg FROM weighings',
  );

  const now = new Date();
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
    months.push(key);
  }

  const grouped = queryAll<MonthBucketRow>(
    `SELECT substr(weighed_at, 1, 7) AS month,
            COUNT(*) AS bills,
            COALESCE(SUM(item_count), 0) AS items,
            ROUND(COALESCE(SUM(total_weight), 0), 3) AS totalKg
     FROM weighings
     WHERE substr(weighed_at, 1, 7) >= ?
     GROUP BY month`,
    months[0],
  );

  const map = new Map<string, MonthBucketRow>(grouped.map((row) => [row.month, row]));
  const series = months.map((month) => map.get(month) || { month, bills: 0, items: 0, totalKg: 0 });

  res.json({ totals, series });
});

app.get('/api/reports/monthly', (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: 'year and month (1-12) are required' });
  }
  const key = `${year}-${pad(month)}`;

  const summary = queryOne<OverviewTotalsRow>(
    `SELECT COUNT(*) AS bills,
            COALESCE(SUM(item_count), 0) AS items,
            ROUND(COALESCE(SUM(total_weight), 0), 3) AS totalKg
     FROM weighings WHERE substr(weighed_at, 1, 7) = ?`,
    key,
  );

  const perItem = queryAll<PerItemRow>(
    `SELECT item_name AS itemName,
            COUNT(*) AS times,
            ROUND(SUM(required_weight), 3) AS totalKg
     FROM weighing_lines
     WHERE weighing_id IN (SELECT id FROM weighings WHERE substr(weighed_at, 1, 7) = ?)
     GROUP BY item_name
     ORDER BY totalKg DESC, itemName ASC`,
    key,
  );

  const perFormula = queryAll<PerFormulaRow>(
    `SELECT formula_name AS formulaName,
            COUNT(*) AS bills,
            ROUND(SUM(total_weight), 3) AS totalKg
     FROM weighings
     WHERE substr(weighed_at, 1, 7) = ? AND formula_name IS NOT NULL
     GROUP BY formula_name
     ORDER BY totalKg DESC, formulaName ASC`,
    key,
  );

  res.json({ year, month, key, summary, perItem, perFormula });
});

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates a day as a real calendar date, not merely a well-shaped string, so
 * a typo such as 2026-02-31 is rejected instead of quietly returning a report
 * with no rows in it.
 */
const normalizeDay = (value: unknown): string | null => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!DAY_PATTERN.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number);
  // new Date() rolls impossible values over (Feb 31 becomes Mar 3), so the
  // round-trip comparison is what actually catches them.
  const parsed = new Date(y, m - 1, d);
  if (
    parsed.getFullYear() !== y ||
    parsed.getMonth() + 1 !== m ||
    parsed.getDate() !== d
  ) {
    return null;
  }
  return raw;
};

app.get('/api/reports/daily', (req, res) => {
  const date = normalizeDay(req.query.date);
  if (!date) {
    return res.status(400).json({ error: 'date is required as YYYY-MM-DD' });
  }

  const summary = queryOne<OverviewTotalsRow>(
    `SELECT COUNT(*) AS bills,
            COALESCE(SUM(item_count), 0) AS items,
            ROUND(COALESCE(SUM(total_weight), 0), 3) AS totalKg
     FROM weighings WHERE substr(weighed_at, 1, 10) = ?`,
    date,
  );

  const perItem = queryAll<PerItemRow>(
    `SELECT item_name AS itemName,
            COUNT(*) AS times,
            ROUND(SUM(required_weight), 3) AS totalKg
     FROM weighing_lines
     WHERE weighing_id IN (SELECT id FROM weighings WHERE substr(weighed_at, 1, 10) = ?)
     GROUP BY item_name
     ORDER BY totalKg DESC, itemName ASC`,
    date,
  );

  const perFormula = queryAll<PerFormulaRow>(
    `SELECT formula_name AS formulaName,
            COUNT(*) AS bills,
            ROUND(SUM(total_weight), 3) AS totalKg
     FROM weighings
     WHERE substr(weighed_at, 1, 10) = ? AND formula_name IS NOT NULL
     GROUP BY formula_name
     ORDER BY totalKg DESC, formulaName ASC`,
    date,
  );

  // The bill-by-bill list is what the day view adds over the month view: it
  // shows the order and timing of production, not just the day's totals.
  const bills = queryAll<WeighingRow>(
    'SELECT * FROM weighings WHERE substr(weighed_at, 1, 10) = ? ORDER BY weighed_at ASC, id ASC',
    date,
  ).map(toBillJson);

  res.json({ date, summary, perItem, perFormula, bills });
});

app.get('/api/reports/yearly', (req, res) => {
  const year = Number(req.query.year);
  if (!Number.isInteger(year)) {
    return res.status(400).json({ error: 'year is required' });
  }

  const rows = queryAll<MonthBucketRow>(
    `SELECT substr(weighed_at, 1, 7) AS month,
            COUNT(*) AS bills,
            COALESCE(SUM(item_count), 0) AS items,
            ROUND(COALESCE(SUM(total_weight), 0), 3) AS totalKg
     FROM weighings WHERE substr(weighed_at, 1, 4) = ?
     GROUP BY month`,
    String(year),
  );

  const filled: MonthBucketRow[] = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${pad(m)}`;
    const row = rows.find((r) => r.month === key);
    filled.push(row || { month: key, bills: 0, items: 0, totalKg: 0 });
  }

  const totals = filled.reduce<OverviewTotalsRow>(
    (acc, m) => {
      acc.bills += Number(m.bills ?? 0);
      acc.items += Number(m.items ?? 0);
      acc.totalKg =
        Math.round((Number(acc.totalKg ?? 0) + Number(m.totalKg ?? 0)) * 1000) / 1000;
      return acc;
    },
    { bills: 0, items: 0, totalKg: 0 },
  );

  res.json({ year, months: filled, totals });
});

// ---------- Static serving (production) ----------

const dist = path.join(ROOT, 'dist');
const staffDist = path.join(ROOT, 'staff-app', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  if (fs.existsSync(staffDist)) {
    app.get('/staff', (_req, res) => {
      res.sendFile(path.join(staffDist, 'index.html'));
    });
    app.use('/staff', express.static(staffDist));
  }
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/staff')) {
      return res.sendFile(path.join(dist, 'index.html'));
    }
    next();
  });
}

// An unknown /api path used to fall through to Express's default HTML 404,
// which the clients then surfaced as "Unexpected token < in JSON".
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Unknown API endpoint' });
});

app.use(
  (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    // body-parser and express attach their own 4xx status to malformed or
    // oversized bodies. Falling back to 500 there told the operator their
    // tablet was at fault when the request was simply unreadable.
    const reported = (err as { status?: number; statusCode?: number } | null)?.status
      ?? (err as { status?: number; statusCode?: number } | null)?.statusCode;
    const status = errorStatus(err, typeof reported === 'number' ? reported : 500);
    res
      .status(status)
      .json({ error: status === 500 ? 'Server error' : errorMessage(err, 'Server error') });
  },
);

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, () => {
    console.log(`Weighing server listening on http://localhost:${PORT}`);
    console.log(`DB: ${process.env.DB_PATH || path.join(__dirname, 'data.db')}`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use — is another server already running?`);
    } else if (err.code === 'EACCES') {
      console.error(`Not allowed to bind port ${PORT}. Ports below 1024 need elevated rights.`);
    } else {
      // Re-thrown, this became an uncaughtException: the process died without
      // closing the serial port or the database. Anything else is equally
      // fatal to a server that cannot listen.
      console.error(`Server could not start: ${err.message}`);
    }
    process.exit(1);
  });

  // A kiosk gets restarted, suspended and unplugged. Without this the process
  // dies holding the serial port and an open SQLite handle, which makes the
  // next boot fail or silently keep stale readings.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down…`);
    scale.stop();
    server.close(() => {
      try {
        db.close();
      } catch {
        // already closed
      }
      console.log('Closed cleanly');
      process.exit(0);
    });
    // Don't hang a supervised restart on a lingering keep-alive socket.
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
