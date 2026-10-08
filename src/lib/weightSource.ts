import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SCALE_PORT } from '../../shared/scale.ts';
import type {
  ScaleReading,
  ScaleStatus,
  ScaleStatusResponse,
} from '../../shared/scale.ts';
import { api } from '../api.ts';
import { apiUrl, getServerOrigin, subscribeToServerAddress } from './serverAddress.ts';

const STREAM_URL = () => apiUrl('/scale/stream');

/**
 * The address the stream is currently pointed at. Re-created on every change so
 * that editing the server address on the SERVER tab rebuilds the EventSource
 * instead of leaving it reconnecting to the old host forever.
 */
function useServerOriginTick(): string {
  const [origin, setOrigin] = useState(() => getServerOrigin() ?? '');
  useEffect(() => subscribeToServerAddress(() => setOrigin(getServerOrigin() ?? '')), []);
  return origin;
}

/**
 * A reading is only trustworthy for as long as the machine keeps sending.
 * The server polls at 100ms, so a frame this old means the link has wedged
 * (scale off, USB replugged, server stalled) and the number on screen is a
 * leftover rather than a live weight. Accepting a frozen value would let an
 * empty pan pass for a full one, so it is dropped instead.
 */
const READING_STALE_MS = 2000;

/** The device state the UI renders, flattened for convenience. */
export interface DeviceState {
  connected: boolean;
  status: ScaleStatus;
  port: string | null;
  baudRate: number;
  message: string | null;
  since: string | null;
  bytesReceived: number;
}

export interface ConnectOptions {
  port?: string;
  baudRate?: number;
}

const IDLE_DEVICE: DeviceState = {
  connected: false,
  status: 'stopped',
  port: null,
  baudRate: 0,
  message: null,
  since: null,
  bytesReceived: 0,
};

const fromStatus = (status: ScaleStatusResponse | null | undefined): DeviceState => ({
  ...IDLE_DEVICE,
  ...status,
  connected: status?.status === 'connected',
});

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** True when the frame is too old to still describe what is on the pan. */
export function isReadingStale(reading: ScaleReading | null, now = Date.now()): boolean {
  if (!reading) return true;
  const at = Date.parse(reading.receivedAt);
  if (!Number.isFinite(at)) return true;
  return now - at > READING_STALE_MS;
}

/**
 * Single source of the current weight.
 *
 * The reading is streamed from the serial scale over SSE; there is no manual
 * entry, so a number on screen always came from the machine. Also owns the
 * device connection: port discovery, connect/disconnect and the live status
 * pushed by the server.
 */
export function useWeightSource() {
  const serverOrigin = useServerOriginTick();
  const [live, setLive] = useState<ScaleReading | null>(null);
  const [device, setDevice] = useState<DeviceState>(IDLE_DEVICE);
  const [baudRates, setBaudRates] = useState<number[]>([9600]);
  const [port, setPort] = useState<string>(DEFAULT_SCALE_PORT);
  const [ports, setPorts] = useState<string[]>([]);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceError, setDeviceError] = useState('');

  const liveRef = useRef<ScaleReading | null>(null);
  liveRef.current = live;

  // Connect and disconnect can be triggered twice before the first request
  // settles (double tap, or a retry after a timeout). Letting both run leaves
  // an orphaned serial handle on the server, so the second is dropped.
  const deviceBusyRef = useRef(false);

  // Reads the server's selected port, visible operating-system ports and
  // supported baud rates. Discovery is repeated when the operator opens the
  // scale panel, so plugging in a USB adapter after startup is supported.
  const refreshScaleInfo = useCallback(async () => {
    try {
      const data = await api.getScalePorts();
      if (typeof data?.port === 'string' && data.port.trim()) setPort(data.port);
      if (Array.isArray(data?.ports)) setPorts(data.ports);
      if (Array.isArray(data?.baudRates) && data.baudRates.length) {
        setBaudRates(data.baudRates);
      }
      // Reaching the server at all clears a stale error. Otherwise one failed
      // probe at boot pins the header to "SCALE ERROR" until the app is
      // restarted, long after the cause has gone.
      setDeviceError('');
    } catch (err) {
      setDeviceError(errText(err));
    }
  }, []);

  const connect = useCallback(async ({ port, baudRate }: ConnectOptions = {}) => {
    if (deviceBusyRef.current) return false;
    deviceBusyRef.current = true;
    setDeviceBusy(true);
    setDeviceError('');
    try {
      const status = await api.connectScale({ port, baudRate });
      setDevice(fromStatus(status));
      return true;
    } catch (err) {
      setDeviceError(errText(err));
      return false;
    } finally {
      deviceBusyRef.current = false;
      setDeviceBusy(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (deviceBusyRef.current) return;
    deviceBusyRef.current = true;
    setDeviceBusy(true);
    setDeviceError('');
    try {
      const status = await api.disconnectScale();
      setDevice(fromStatus(status));
      setLive(null);
    } catch (err) {
      setDeviceError(errText(err));
    } finally {
      deviceBusyRef.current = false;
      setDeviceBusy(false);
    }
  }, []);

  // Live stream. Always on: weighing has no other source.
  useEffect(() => {
    let closed = false;
    const source = new EventSource(STREAM_URL());

    const onStatus = (event: MessageEvent) => {
      let next: ScaleStatusResponse | null = null;
      try {
        next = JSON.parse(event.data) as ScaleStatusResponse;
      } catch {
        return;
      }
      if (closed) return;
      setDevice(fromStatus(next));
      // The server is answering, so any earlier probe failure is over. Leaving
      // it set would keep an error banner up against a working scale.
      setDeviceError('');
      // A dropped connection must not leave a stale weight looking valid.
      if (next?.status !== 'connected') setLive(null);
    };

    const onReading = (event: MessageEvent) => {
      let next: ScaleReading | null = null;
      try {
        next = JSON.parse(event.data) as ScaleReading;
      } catch {
        return;
      }
      if (closed) return;
      if (!Number.isFinite(next?.weight)) return;
      if (isReadingStale(next)) return;
      setLive(next);
    };

    source.addEventListener('status', onStatus as EventListener);
    source.addEventListener('reading', onReading as EventListener);
    source.onerror = () => {
      if (closed) return;
      // A dropped EventSource only fires onerror, so the last weight has to be
      // dropped here too. Leaving it up would show a frozen number on screen
      // while the header reports the scale as offline.
      setLive(null);
      setDevice((d) => ({
        ...d,
        connected: false,
        status: 'stopped',
        message: 'Lost connection to the scale service',
      }));
    };

    return () => {
      closed = true;
      source.removeEventListener('status', onStatus as EventListener);
      source.removeEventListener('reading', onReading as EventListener);
      source.close();
    };
  }, [serverOrigin]);

  // Expire a reading whose frames stopped arriving. The stream staying open
  // does not prove the scale is still talking to it.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setLive((current) => (isReadingStale(current) ? null : current));
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  // Read the scale status and the server's port on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await api.getScaleStatus();
        if (!cancelled) setDevice(fromStatus(status));
      } catch (err) {
        if (!cancelled) setDeviceError(errText(err));
      }
    })();
    refreshScaleInfo();
  }, [refreshScaleInfo, serverOrigin]);

  const getReading = useCallback((): number | null => {
    const current = liveRef.current;
    return current && !isReadingStale(current) ? current.weight : null;
  }, []);

  return {
    live,
    device,
    getReading,
    port,
    baudRates,
    ports,
    refreshScaleInfo,
    deviceBusy,
    deviceError,
    connect,
    disconnect,
  };
}
