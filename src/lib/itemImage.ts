/**
 * Client-side picture handling for item photos.
 *
 * A phone camera produces files of several megabytes, and a weighing station
 * only ever shows the picture as a thumbnail. Resizing in the browser before
 * the upload keeps the request small, the stored file small, and the screen
 * responsive, and it means the server never needs an image library.
 */

/** Longest edge kept when resizing. Comfortably above any display size. */
const MAX_EDGE = 640;

/** JPEG quality for the re-encoded upload. */
const QUALITY = 0.82;

/** Refuse anything larger before decoding, so a huge file cannot hang the tab. */
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

export class ImageTooLargeError extends Error {}

/**
 * Types the file picker should offer. The upload is re-encoded to JPEG
 * afterwards, so this is about which files the operator can *select*: every
 * format a browser can decode is fine, and HEIC/HEIF are listed so an iPhone
 * photo at least appears in the picker instead of being silently hidden.
 */
export const IMAGE_ACCEPT = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
  'image/svg+xml',
  'image/heic',
  'image/heif',
].join(',');

/** Filenames ending in these count as images even when the OS reports no MIME type. */
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif|avif|bmp|svg|heic|heif)$/i;

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      // Almost always an iPhone HEIC/HEIF, which desktop Chrome and the
      // Android WebView cannot decode. Say so instead of a bare failure.
      reject(
        new Error(
          /heic|heif/i.test(file.type) || IMAGE_EXTENSIONS.test(file.name)
            ? 'That file could not be read as an image. If it is a photo taken on an iPhone, it may be HEIC/HEIF — please save it as JPG or PNG first.'
            : 'That file could not be read as an image. Please choose a JPG, PNG or WebP picture.',
        ),
      );
    };
    img.src = url;
  });
}

/**
 * Reads a picked file and returns it as a downscaled JPEG data URL, ready to
 * POST. Transparency is flattened onto white first, because JPEG has no alpha
 * channel and would otherwise render transparent areas black.
 */
export async function fileToResizedDataUrl(file: File): Promise<string> {
  // Some pickers report an empty type, so fall back to the extension rather
  // than rejecting a genuine photo.
  if (file.type && !file.type.startsWith('image/') && !IMAGE_EXTENSIONS.test(file.name)) {
    throw new Error('Please choose an image file.');
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new ImageTooLargeError(
      `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. Please pick one under ${Math.round(MAX_INPUT_BYTES / 1024 / 1024)} MB.`,
    );
  }

  const img = await loadImageElement(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This device cannot process images.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  return canvas.toDataURL('image/jpeg', QUALITY);
}
