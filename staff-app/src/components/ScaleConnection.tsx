import { useEffect, useState } from 'react';
import { DEFAULT_SCALE_PORT } from '../../../shared/scale.ts';
import type { ConnectOptions, DeviceState } from '../lib/weightSource.ts';

const FALLBACK_BAUD = 9600;
const FALLBACK_PORT = DEFAULT_SCALE_PORT;

const statusText = (device: DeviceState | null | undefined): string => {
  if (!device) return '';
  if (device.status === 'connected') {
    const rate = device.baudRate ? ` @ ${device.baudRate} baud` : '';
    return `Connected to ${device.port}${rate}`;
  }
  return device.message || 'Not connected';
};

export interface ScaleConnectionProps {
  device: DeviceState;
  /** The single fixed port the scale is read from. */
  port: string;
  baudRates: number[];
  deviceBusy: boolean;
  deviceError: string;
  connect: (options?: ConnectOptions) => Promise<boolean>;
  disconnect: () => Promise<void>;
}

/**
 * Scale link controls. The port is fixed rather than chosen: a shop has one
 * machine on one adapter, so a picker only ever offered the wrong answer
 * alongside the right one. It is shown as text so an operator can still see
 * what is being read and what to plug into.
 */
export function ScaleConnection({
  device,
  port,
  baudRates,
  deviceBusy,
  deviceError,
  connect,
  disconnect,
}: ScaleConnectionProps) {
  const [baudRate, setBaudRate] = useState(FALLBACK_BAUD);

  useEffect(() => {
    if (device?.baudRate) setBaudRate(device.baudRate);
  }, [device?.baudRate]);

  // What the server is actually using wins over the built-in default, so a
  // bench set up on another port shows the truth rather than a stale /dev/ttyS1.
  const shownPort = device?.port || port || FALLBACK_PORT;
  const connected = Boolean(device?.connected);

  return (
    <div className="scale-conn">
      <div className="scale-conn-body">
        <span className="scale-port-fixed" title="The scale is read from this port">
          {shownPort}
        </span>

        <select
          className="scale-baud-select"
          value={baudRate}
          onChange={(event) => setBaudRate(Number(event.target.value))}
          aria-label="Baud rate"
        >
          {(baudRates.length ? baudRates : [FALLBACK_BAUD]).map((rate) => (
            <option key={rate} value={rate}>
              {rate}
            </option>
          ))}
        </select>

        {connected ? (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={disconnect}
            disabled={deviceBusy}
          >
            DISCONNECT
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => connect({ port: shownPort, baudRate })}
            disabled={deviceBusy}
          >
            {deviceBusy ? 'CONNECTING…' : 'CONNECT'}
          </button>
        )}

        <span className="scale-conn-status">
          {deviceError ? <b className="err">{deviceError}</b> : statusText(device)}
        </span>
      </div>

      <span className="mode-badge">
        {connected ? 'SCALE ONLINE' : 'SCALE OFFLINE'}
        <span className={`mode-dot${connected ? ' on' : ' err'}`} />
      </span>
    </div>
  );
}
