import { useEffect, useState } from 'react';
import { DEFAULT_SCALE_PORT } from '../../shared/scale.ts';
import type { ConnectOptions, DeviceState } from '../lib/weightSource.ts';
import { api } from '../api.ts';

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
  /** The port currently selected by the server. */
  port: string;
  /** Ports currently visible to the Windows/Linux serial driver. */
  ports: string[];
  baudRates: number[];
  deviceBusy: boolean;
  deviceError: string;
  refresh: () => Promise<void>;
  connect: (options?: ConnectOptions) => Promise<boolean>;
  disconnect: () => Promise<void>;
}

/**
 * Scale link controls. The selected port comes from the operating system's
 * current serial-port list, which includes COM ports on Windows.
 */
export function ScaleConnection({
  device,
  port,
  ports,
  baudRates,
  deviceBusy,
  deviceError,
  refresh,
  connect,
  disconnect,
}: ScaleConnectionProps) {
  const [baudRate, setBaudRate] = useState(FALLBACK_BAUD);
  const [selectedPort, setSelectedPort] = useState(port);
  const [plcIp, setPlcIp] = useState('192.168.250.1');
  const [plcIpInput, setPlcIpInput] = useState('192.168.250.1');
  const [plcIpMessage, setPlcIpMessage] = useState('');

  useEffect(() => {
    if (device?.baudRate) setBaudRate(device.baudRate);
  }, [device?.baudRate]);

  useEffect(() => {
    if (ports.length && !ports.includes(selectedPort)) setSelectedPort(ports[0]);
    else if (!selectedPort) setSelectedPort(port);
  }, [port, ports, selectedPort]);

  useEffect(() => {
    void api.getPlcConfig().then(({ ip }) => {
      setPlcIp(ip);
      setPlcIpInput(ip);
    }).catch(() => setPlcIpMessage('PLC IP unavailable'));
  }, []);

  async function savePlcIp() {
    setPlcIpMessage('Saving...');
    try {
      const { ip } = await api.setPlcConfig(plcIpInput.trim());
      setPlcIp(ip);
      setPlcIpInput(ip);
      setPlcIpMessage('PLC IP saved');
    } catch (error) {
      setPlcIpMessage(error instanceof Error ? error.message : String(error));
    }
  }

  // What the server is actually using wins over the built-in default, so a
  // bench set up on another port shows the truth rather than a stale /dev/ttyS1.
  const shownPort = device?.port || port || FALLBACK_PORT;
  const connected = Boolean(device?.connected);

  return (
    <div className="scale-conn">
      <div className="scale-conn-body">
        <select
          className="scale-port-select"
          value={selectedPort}
          onChange={(event) => setSelectedPort(event.target.value)}
          aria-label="Serial port"
        >
          {ports.length ? ports.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>) : (
            <option value={shownPort}>{shownPort}</option>
          )}
        </select>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()} disabled={deviceBusy}>
          RESCAN
        </button>

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
            onClick={() => connect({ port: selectedPort || shownPort, baudRate })}
            disabled={deviceBusy}
          >
            {deviceBusy ? 'CONNECTING…' : 'CONNECT'}
          </button>
        )}

        <span className="scale-conn-status">
          {deviceError ? <b className="err">{deviceError}</b> : statusText(device)}
        </span>
      </div>

      <div className="scale-plc-config">
        <label htmlFor="plc-ip">PLC IP</label>
        <input
          id="plc-ip"
          className="scale-plc-ip"
          value={plcIpInput}
          onChange={(event) => setPlcIpInput(event.target.value)}
          inputMode="decimal"
          placeholder={plcIp}
          aria-label="PLC IP address"
        />
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void savePlcIp()}>
          SAVE
        </button>
        {plcIpMessage && <span className="scale-plc-message">{plcIpMessage}</span>}
      </div>

      <span className="mode-badge">
        {connected ? 'SCALE ONLINE' : 'SCALE OFFLINE'}
        <span className={`mode-dot${connected ? ' on' : ' err'}`} />
      </span>
    </div>
  );
}
