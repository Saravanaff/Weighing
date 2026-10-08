import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { SEED_ITEMS } from './seedData.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

export const db = new DatabaseSync(DB_PATH);

/**
 * A row as node:sqlite hands it back: every column may be absent and the value
 * may be any SQL type. Callers should go through the typed helpers below rather
 * than touching these values directly.
 */
export type SqlRow = Record<string, SQLOutputValue>;

/** Values accepted as bound statement parameters. */
export type SqlParam = string | number | bigint | null | Uint8Array;

export function queryOne<T>(sql: string, ...params: SqlParam[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function queryAll<T>(sql: string, ...params: SqlParam[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(sql: string, ...params: SqlParam[]) {
  return db.prepare(sql).run(...params);
}

const hasTable = (name: string): boolean =>
  !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

const hasCol = (table: string, column: string): boolean =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((col) => (col as SqlRow).name === column);

const columnNames = (table: string): string[] =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((col) => (col as SqlRow).name as string);

function migrateLegacyRecipeTables() {
  if (hasTable('recipes') && !hasTable('formulas')) {
    db.exec('ALTER TABLE recipes RENAME TO formulas');
    console.log('Migrated table recipes -> formulas');
  }
  if (hasTable('recipe_lines') && !hasTable('formula_lines')) {
    db.exec('ALTER TABLE recipe_lines RENAME TO formula_lines');
    console.log('Migrated table recipe_lines -> formula_lines');
  }
  if (hasTable('formula_lines') && hasCol('formula_lines', 'recipe_id') && !hasCol('formula_lines', 'formula_id')) {
    db.exec('ALTER TABLE formula_lines RENAME COLUMN recipe_id TO formula_id');
    console.log('Migrated column formula_lines.recipe_id -> formula_id');
  }
  db.exec('DROP INDEX IF EXISTS idx_recipe_lines_recipe');
}

export function initDb() {
  // Without this, SQLite reports "database is locked" the instant a second
  // process touches the file -- a nightly backup, a VACUUM INTO, or the DB
  // Browser open on a laptop. Waiting is far better than a 500 per bill.
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  migrateLegacyRecipeTables();

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      name_hi TEXT NOT NULL DEFAULT '',
      name_bn TEXT NOT NULL DEFAULT '',
      name_ta TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS weighings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_no TEXT NOT NULL,
      weighed_at TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      total_weight REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS weighing_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      weighing_id INTEGER NOT NULL REFERENCES weighings(id) ON DELETE CASCADE,
      item_id INTEGER,
      item_name TEXT NOT NULL,
      required_weight REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS formulas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      item_count INTEGER NOT NULL DEFAULT 0,
      total_weight REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS formula_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      formula_id INTEGER NOT NULL REFERENCES formulas(id) ON DELETE CASCADE,
      item_id INTEGER,
      item_name TEXT NOT NULL,
      required_weight REAL NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_weighings_weighed_at ON weighings(weighed_at);
    CREATE INDEX IF NOT EXISTS idx_lines_weighing ON weighing_lines(weighing_id);
    CREATE INDEX IF NOT EXISTS idx_formula_lines_formula ON formula_lines(formula_id);
  `);

  const weighingCols = columnNames('weighings');
  if (!weighingCols.includes('formula_name')) {
    if (weighingCols.includes('recipe_name')) {
      db.exec('ALTER TABLE weighings RENAME COLUMN recipe_name TO formula_name');
      console.log('Migrated weighings: recipe_name -> formula_name');
    } else {
      db.exec('ALTER TABLE weighings ADD COLUMN formula_name TEXT');
      console.log('Migrated weighings: added formula_name column');
    }
  }

  // A bill used to record only the target weight, so drift between what was
  // asked for and what was actually weighed could never be reconstructed. New
  // bills store the measured weight; existing rows keep NULL ("not recorded").
  if (!hasCol('weighing_lines', 'actual_weight')) {
    db.exec('ALTER TABLE weighing_lines ADD COLUMN actual_weight REAL');
    console.log('Migrated weighing_lines: added actual_weight column');
  }

  // Item photos live as files under server/storage/item-images. The row keeps
  // only the path, so the database never grows by the size of the pictures and
  // a backup of the .db alone stays small.
  if (!hasCol('items', 'image_path')) {
    db.exec('ALTER TABLE items ADD COLUMN image_path TEXT');
    console.log('Migrated items: added image_path column');
  }

  // Client generated reference for a bill, unique when present. A weighing is
  // saved at the one moment most likely to fail on a shop Wi-Fi: if the server
  // commits the insert and the response is lost, the operator presses RETRY
  // SAVE. Without this column that retry writes a second identical bill, new
  // batch number and all, and the batch is double counted in every report.
  if (!hasCol('weighings', 'client_ref')) {
    db.exec('ALTER TABLE weighings ADD COLUMN client_ref TEXT');
    console.log('Migrated weighings: added client_ref column');
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_weighings_client_ref ON weighings(client_ref) WHERE client_ref IS NOT NULL',
  );

  const count = Number(queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM items')?.n ?? 0);
  if (count === 0) {
    const insert = db.prepare(
      'INSERT INTO items (slug, code, name, name_hi, name_bn, name_ta) VALUES (?, ?, ?, ?, ?, ?)',
    );
    SEED_ITEMS.forEach((item, index) => {
      const code = `RM-${String(index + 1).padStart(2, '0')}`;
      insert.run(item.slug, code, item.name, item.hi, item.bn, item.ta);
    });
    console.log('Seeded item master with', SEED_ITEMS.length, 'items');
  } else {
    console.log('Item master already seeded:', count, 'items');
  }
}