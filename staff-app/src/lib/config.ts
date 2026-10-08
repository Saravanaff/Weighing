const ROOT = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');

export const API_BASE = `${ROOT}/api`;
export const TTS_BASE = `${ROOT}/tts`;

/**
 * Turns a stored item-photo path ('/item-images/x.jpg') into a URL. The path is
 * all the items row holds; the picture itself is a file on the server.
 */
export const itemImageUrl = (storedPath: string | null | undefined): string | null => {
  if (!storedPath) return null;
  return `${ROOT}${storedPath.startsWith('/') ? '' : '/'}${storedPath}`;
};