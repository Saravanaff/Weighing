import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { httpError } from './errors.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where the pictures live. Kept out of the .db file on purpose. */
export const ITEM_IMAGES_DIR = path.join(__dirname, 'storage', 'item-images');

/** Public URL prefix the clients build image srcs from. */
export const ITEM_IMAGES_URL = '/item-images';

/**
 * Only real raster formats are allowed. The extension is derived from the
 * sniffed magic bytes rather than from the client-supplied name, so a caller
 * cannot talk the server into writing "x.png" full of HTML.
 */
const SIGNATURES: Array<{ ext: string; mime: string; test: (b: Buffer) => boolean }> = [
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.subarray(0, 6).toString('ascii') === 'GIF89a' || b.subarray(0, 6).toString('ascii') === 'GIF87a' },
];

/** 4 MB of pixels is plenty for a thumbnail shown on a weighing screen. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Decodes a `data:` URL into bytes plus the format we detected. Rejects
 * anything that is not one of the four allowed image types so a script or an
 * HTML file can never be written into the served directory.
 */
export function decodeImageDataUrl(dataUrl: unknown): { bytes: Buffer; ext: string } {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
     throw httpError(400, 'Image must be sent as a data: URL');
  }
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw httpError(400, 'Malformed image data');

  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const bytes = header.includes(';base64')
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');

  if (bytes.length === 0) throw httpError(400, 'Image is empty');
  if (bytes.length > MAX_IMAGE_BYTES) {
     throw httpError(400, `Image is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`);
  }
  const signature = SIGNATURES.find((candidate) => candidate.test(bytes));
  if (!signature) throw httpError(400, 'Image must be a JPEG, PNG, WebP or GIF file');

  return { bytes, ext: signature.ext };
}

export function ensureItemImagesDir(): void {
  fs.mkdirSync(ITEM_IMAGES_DIR, { recursive: true });
}

/**
 * Writes the bytes under a random name and returns the path to store in the
 * items row. The random suffix means two items with the same name, or a
 * re-upload, can never overwrite a picture that is still in use.
 */
export function saveItemImage(slug: string, bytes: Buffer, ext: string): string {
  ensureItemImagesDir();
  const safeSlug = slugifyForFile(slug);
  const fileName = `${safeSlug}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(ITEM_IMAGES_DIR, fileName), bytes);
  return `${ITEM_IMAGES_URL}/${fileName}`;
}

/** Removes a stored picture. Missing files are not an error. */
export function deleteItemImage(storedPath: unknown): void {
  if (typeof storedPath !== 'string' || !storedPath) return;
  const fileName = path.basename(storedPath);
  if (!fileName || fileName === '.' || fileName === '..') return;
  try {
    fs.rmSync(path.join(ITEM_IMAGES_DIR, fileName), { force: true });
  } catch {
    // A picture that is already gone is not worth failing a request over.
  }
}

const slugifyForFile = (text: string): string =>
  text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'item';
