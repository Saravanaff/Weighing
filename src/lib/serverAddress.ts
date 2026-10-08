import { Capacitor } from '@capacitor/core';

/**
 * Where the app finds the weighing server.
 *
 * On a desktop browser the whole app is served by that same server, so a
 * same-origin relative URL ('/api') is correct and needs no configuration.
 *
 * Inside the Android build the page is served by the WebView from
 * http://localhost, so 'localhost' would mean the phone itself. There the
 * address of the machine holding the scale has to be entered once and kept in
 * localStorage, because the LAN address a router hands out will change sooner
 * or later and a baked-in URL would leave the app dead until it is rebuilt.
 *
 * Both schemes are accepted, so the same build works against the PC on the
 * shop LAN over http and against a hosted https link. The page is served over
 * http precisely so that neither case is a mixed-content block: an insecure page
 * may still call an https API, but not the other way round.
 */

const STORAGE_KEY = 'koushi.serverUrl';
export const DEFAULT_PORT = 3001;

export type AddressScheme = 'http' | 'https';

export interface ParsedAddress {
  scheme: AddressScheme;
  host: string;
  /** null when the address did not name one; the scheme's own default then applies. */
  port: number | null;
  /** Base path with no trailing slash, e.g. '/weighing'. Empty when absent. */
  path: string;
}

/** True when running inside the Android/iOS shell rather than a browser tab. */
export const isNativeApp = (): boolean => Capacitor.isNativePlatform();

/**
 * Accepts what an operator or a deployment would actually type:
 * '192.168.1.23', '192.168.1.23:3001', 'http://192.168.1.23:3001',
 * 'https://weigh.example.com', 'https://example.com/weighing'.
 *
 * A bare host is assumed to be the LAN case — http on the default port. An
 * explicit http:// or https:// is honoured exactly as written, including a
 * hosted base path, so an https link is never silently downgraded.
 */
export function parseAddress(input: string): ParsedAddress | null {
  const raw = (typeof input === 'string' ? input : '').trim();
  if (!raw) return null;

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  let scheme: AddressScheme | null = null;
  let rest = raw;
  if (schemeMatch) {
    const found = schemeMatch[1].toLowerCase();
    if (found !== 'http' && found !== 'https') return null;
    scheme = found;
    rest = raw.slice(schemeMatch[0].length);
  }

  // Credentials, query strings and fragments are not part of a server address.
  if (/[@?#]/.test(rest)) return null;

  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash).replace(/\/+$/, '');
  if (!authority) return null;

  // A bracketed IPv6 literal, or a bare one, may carry a port after a colon.
  const match = /^(.*?)(?::(\d{1,5}))?$/.exec(authority);
  if (!match) return null;
  const host = match[1];
  if (!host) return null;
  if (/\s/.test(host)) return null;
  if (host.includes(':') && !host.startsWith('[')) {
    // A bare IPv6 literal has several colons, so it cannot also carry a port.
    return null;
  }
  const bareHost = host.replace(/^\[|\]$/g, '');

  let port: number | null;
  if (match[2] != null) {
    port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  } else if (scheme) {
    // An explicit URL with no port means the scheme's own default.
    port = null;
  } else {
    port = DEFAULT_PORT;
  }

  return { scheme: scheme ?? 'http', host: bareHost, port, path };
}

/**
 * Canonical origin for an address, e.g. 'http://192.168.1.23:3001' or
 * 'https://weigh.example.com'. A port is omitted when the address did not name
 * one, so a hosted link keeps its real shape instead of picking up :3001.
 */
export const addressOrigin = ({ scheme, host, port, path }: ParsedAddress): string =>
  `${scheme}://${host.includes(':') ? `[${host}]` : host}${port == null ? '' : `:${port}`}${path}`;

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private mode or storage disabled; the app then runs same-origin only.
    return null;
  }
}

let current: string | null = readStored();
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

/** Subscribe to address changes; returns an unsubscribe function. */
export function subscribeToServerAddress(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current stored origin, or null when running same-origin. */
export function getServerOrigin(): string | null {
  if (!isNativeApp()) return null;
  return current;
}

/** Persist (or clear) the address. Throws on an unusable input. */
export function setServerOrigin(value: string | null): void {
  if (value == null || value.trim() === '') {
    current = null;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // nothing persisted
    }
    emit();
    return;
  }
  const parsed = parseAddress(value);
  if (!parsed) throw new Error('That server address is not valid.');
  const origin = addressOrigin(parsed);
  current = origin;
  try {
    window.localStorage.setItem(STORAGE_KEY, origin);
  } catch {
    // Not persisted, but it still works for this session.
  }
  emit();
}

/** The configured origin, or '' for same-origin requests. */
export function serverBase(): string {
  if (!isNativeApp()) return '';
  return current ?? '';
}

/** Full URL for an API path, honouring the configured server. */
export function apiUrl(path: string): string {
  return `${serverBase()}/api${path}`;
}

/** Base for generated voice clips. */
export function ttsBase(): string {
  return `${serverBase()}/tts`;
}

/**
 * Full URL for a stored item photo. The items table only holds a path such as
 * '/item-images/maize-1a2b3c.jpg', so this turns it into something an <img> can
 * load. Same rules as the API: a same-origin path in the browser, and the
 * configured server in the Android build.
 */
export function itemImageUrl(storedPath: string | null | undefined): string | null {
  if (!storedPath) return null;
  return `${serverBase()}${storedPath.startsWith('/') ? '' : '/'}${storedPath}`;
}

/**
 * True when the app still needs a server address before it can do anything.
 * In the Android build that is exactly "nothing stored yet".
 */
export function needsServerAddress(): boolean {
  return isNativeApp() && !current;
}
