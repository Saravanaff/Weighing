import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpError } from './errors.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TTS_DIR = path.join(__dirname, 'storage', 'tts');

export type Lang = 'en' | 'hi' | 'bn' | 'ta';
/** The three regional names we resolve, always present on an item. */
export type NativeNames = { hi: string; bn: string; ta: string };
export type ItemNames = NativeNames & { en: string };

const TARGET_LANGS: Lang[] = ['en', 'hi', 'bn', 'ta'];
const TRANSLATE_LANGS: Array<keyof NativeNames> = ['hi', 'bn', 'ta'];
const UA = { 'User-Agent': 'Mozilla/5.0' };
/**
 * A shop router with no WAN accepts the TCP connection and then never answers.
 * Undici's own headers/body timeouts are 300s, so without this a single
 * unreachable vendor costs minutes per call and the request that triggered it
 * hangs with the item row already committed.
 */
const REMOTE_TIMEOUT_MS = 10_000;
const remoteSignal = () => AbortSignal.timeout(REMOTE_TIMEOUT_MS);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Google's free endpoints answer 429 under a burst; adding a few items in a row
 * is enough to trip it. Without a retry the translation silently fell back to
 * the English name and the voice clip was then generated from that English
 * text, so the item said the wrong thing in every language. Retrying with a
 * growing pause turns nearly all of those one-off failures into successes.
 */
const REMOTE_ATTEMPTS = 3;
const RETRY_BASE_MS = 700;

export function ensureTtsDirs() {
  for (const lang of TARGET_LANGS) {
    fs.mkdirSync(path.join(TTS_DIR, lang), { recursive: true });
  }
}

/**
 * The `client=gtx` query string is the one Google rate-limits first, and when
 * it does, every translation for that item used to fall back to English. The
 * browser-extension client answers out of a different bucket, so both are
 * tried before giving up.
 */
const TRANSLATE_CLIENTS = ['dict-chrome-ex', 'gtx'];

async function translateWithClient(text: string, target: string, client: string): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=${client}&sl=en&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: UA, signal: remoteSignal() });
  if (!res.ok) throw httpError(502, `translate http ${res.status}`);
  // The endpoint replies with [[segment, source, target, ...], ...].
  const data = (await res.json()) as unknown;
  const segments = Array.isArray(data) ? (data[0] as unknown) : undefined;
  const translated = Array.isArray(segments)
    ? segments
        .map((segment) => (Array.isArray(segment) ? String(segment[0] ?? '') : ''))
        .join('')
        .trim()
    : '';
  return translated || text;
}

async function translateOnce(text: string, target: string): Promise<string> {
  let lastError: unknown;
  for (const client of TRANSLATE_CLIENTS) {
    try {
      return await translateWithClient(text, target, client);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Retries a single translation so a transient 429 does not become English. */
async function translateText(text: string, target: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= REMOTE_ATTEMPTS; attempt += 1) {
    try {
      return await translateOnce(text, target);
    } catch (err) {
      lastError = err;
      if (attempt < REMOTE_ATTEMPTS) await delay(RETRY_BASE_MS * attempt);
    }
  }
  throw lastError;
}

export async function resolveNames(
  name: string,
  provided: Partial<NativeNames> = {},
): Promise<NativeNames> {
  const base: NativeNames = { hi: '', bn: '', ta: '' };
  for (const lang of TRANSLATE_LANGS) {
    const given = String(provided[lang] || '').trim();
    if (given) {
      base[lang] = given;
    } else {
      try {
        base[lang] = await translateText(name, lang);
      } catch (err) {
        console.warn(`translate fallback ${lang}: ${err instanceof Error ? err.message : err}`);
        base[lang] = name;
      }
    }
  }
  return base;
}

/**
 * Re-resolves the names for an existing item. A native name that already
 * differs from the English one was either typed by hand or translated before, so
 * it is kept; anything still equal to the English name is a failed translation
 * and is translated again. Used by the ITEM MASTER "REGENERATE" action to repair
 * items that were added while the translator was rate-limiting.
 */
export async function regenerateNames(name: string, current: NativeNames): Promise<NativeNames> {
  const requested: Partial<NativeNames> = {};
  const trimmed = name.trim();
  for (const lang of TRANSLATE_LANGS) {
    const value = (current[lang] || '').trim();
    if (value && value !== trimmed) requested[lang] = value;
  }
  return resolveNames(name, requested);
}

async function fetchMp3(text: string, lang: string): Promise<Buffer> {
  const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=gtx&tl=${lang}&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: UA, signal: remoteSignal() });
  const buffer = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') || '';
  if (!res.ok || buffer.length < 2000 || !type.includes('audio')) {
    throw httpError(502, `bad tts http=${res.status} type=${type} bytes=${buffer.length}`);
  }
  return buffer;
}

async function downloadMp3(text: string, lang: string, filePath: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= REMOTE_ATTEMPTS; attempt += 1) {
    try {
      const buffer = await fetchMp3(text, lang);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, buffer);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < REMOTE_ATTEMPTS) await delay(RETRY_BASE_MS * attempt);
    }
  }
  throw lastError;
}

export async function downloadItemAudio(slug: string, names: ItemNames) {
  for (const lang of TARGET_LANGS) {
    const filePath = path.join(TTS_DIR, lang, `${slug}.mp3`);
    try {
      await downloadMp3(names[lang] || names.en || slug, lang, filePath);
      console.log(`TTS OK  ${lang}/${slug}`);
    } catch (err) {
      console.warn(`TTS FAIL ${lang}/${slug}: ${err instanceof Error ? err.message : err}`);
    }
    await delay(300);
  }
}

export function deleteItemAudio(slug: string) {
  for (const lang of TARGET_LANGS) {
    try {
      fs.rmSync(path.join(TTS_DIR, lang, `${slug}.mp3`), { force: true });
    } catch {
      // ignore removal errors
    }
  }
}