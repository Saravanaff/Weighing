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

export function ensureTtsDirs() {
  for (const lang of TARGET_LANGS) {
    fs.mkdirSync(path.join(TTS_DIR, lang), { recursive: true });
  }
}

async function translateText(text: string, target: string): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
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

async function downloadMp3(text: string, lang: string, filePath: string) {
  const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=gtx&tl=${lang}&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: UA, signal: remoteSignal() });
  const buffer = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') || '';
  if (!res.ok || buffer.length < 2000 || !type.includes('audio')) {
    throw httpError(502, `bad tts http=${res.status} type=${type} bytes=${buffer.length}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);
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