import { useState } from 'react';
import { api } from '../api.ts';
import {
  addressOrigin,
  DEFAULT_PORT,
  getServerOrigin,
  isNativeApp,
  parseAddress,
  setServerOrigin,
} from '../lib/serverAddress.ts';

export interface ServerScreenProps {
  /** True on first run in the app, where the screen is a hard requirement. */
  firstRun: boolean;
  onDone: () => void;
  onCancel?: () => void;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Asks for the address of the machine that holds the scale and the database.
 *
 * The Android app is a client of that server, not a copy of it: weighing
 * records live in the server's SQLite file, and the serial port belongs to the
 * server process. So this address is what makes the app work at all, and it is
 * stored on the device rather than compiled in, because the LAN address will
 * eventually change.
 */
export function ServerScreen({ firstRun, onDone, onCancel }: ServerScreenProps) {
  // Prefilled from the saved address so an existing setup opens ready to edit
  // rather than blank. Empty on first run, which is the only time it is asked.
  const [host, setHost] = useState(() => getServerOrigin() ?? '');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const candidate = parseAddress(host);

  async function testConnection(): Promise<void> {
    if (!candidate) {
      setResult({ ok: false, message: 'Enter the server address first.' });
      return;
    }
    setTesting(true);
    setResult(null);
    // Read defensively: a WebView with storage disabled throws here, and doing
    // it outside the try would reject the whole async function and leave the
    // button stuck on "TESTING…" for good.
    let previous: string | null = null;
    try {
      previous = isNativeApp() ? window.localStorage.getItem('koushi.serverUrl') : null;
    } catch {
      previous = null;
    }
    // Applied before testing so the probe goes to the address being typed,
    // then rolled back if the operator cancels.
    setServerOrigin(addressOrigin(candidate));
    try {
      const health = await api.getItems();
      setResult({
        ok: true,
        message: `Connected. ${Array.isArray(health) ? health.length : 0} items loaded from the server.`,
      });
    } catch (err) {
      setResult({ ok: false, message: errText(err) });
      if (previous) setServerOrigin(previous);
      else setServerOrigin(null);
    } finally {
      setTesting(false);
    }
  }

  function save(): void {
    if (!candidate) {
      setResult({ ok: false, message: 'Enter the server address first.' });
      return;
    }
    setServerOrigin(addressOrigin(candidate));
    onDone();
  }

  return (
    <section className="stage server-setup">
      <div className="panel server-setup-panel">
        <div className="screen-title">
          {firstRun ? 'CONNECT TO THE WEIGHING SERVER' : 'SERVER ADDRESS'}
        </div>
        <div className="screen-sub">
          {firstRun
            ? 'This app works against the computer that holds the scale. Enter its address on this network to continue.'
            : 'Change which weighing server this app talks to.'}
        </div>

        <div className="server-fields">
          <div className="form-field">
            <label className="form-label" htmlFor="server-host">
              Server address
            </label>
            <input
              id="server-host"
              className="text-input"
              type="text"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="192.168.1.23:3001 or https://weigh.example.com"
              value={host}
              onChange={(event) => setHost(event.target.value)}
            />
            <div className="field-hint">
              The computer the scale is plugged into, on this network — or the
              hosted address if the server is online. A plain IP defaults to
              port {DEFAULT_PORT}; an address that starts with http:// or
              https:// is used exactly as typed.
            </div>
          </div>
        </div>

        {candidate && (
          <div className="server-preview">
            Requests will go to <b>{addressOrigin(candidate)}</b>
          </div>
        )}

        {result && (
          <div className={result.ok ? 'server-result ok' : 'server-result fail'}>
            {result.message}
          </div>
        )}

        <div className="server-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void testConnection()}
            disabled={testing || !candidate}
          >
            {testing ? 'TESTING…' : 'TEST CONNECTION'}
          </button>
          <button type="button" className="btn btn-primary btn-lg" onClick={save} disabled={!candidate}>
            {firstRun ? 'CONNECT' : 'SAVE'}
          </button>
          {onCancel && (
            <button type="button" className="btn btn-secondary" onClick={onCancel}>
              CANCEL
            </button>
          )}
        </div>

        {firstRun && (
          <div className="server-note">
            <p>
              The weighing server must be running on that computer. If the app
              cannot connect, check that both devices are on the same Wi-Fi and
              that nothing blocks port {DEFAULT_PORT}.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
