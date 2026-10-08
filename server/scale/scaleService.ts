import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SCALE_PORT } from '../../shared/scale.ts';
import type {
  ScaleReading,
  ScaleStatus,
  ScaleStatusInfo,
} from '../../shared/scale.ts';
import {
  parseYaohuaFrame,
  YAOHUA_FRAME_LENGTH,
  YAOHUA_START_CHAR,
} from './yaohua.ts';

// Last selected port/baud persists here so a restart keeps using it until the
// user picks a different one (same pattern as the PLC's plc-config.json).
const SCALE_CONFIG_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scale-config.json',
);

interface PersistedScaleConfig {
  port?: string;
  baudRate?: number;
}

function loadPersistedConfig(): PersistedScaleConfig {
  try {
    return JSON.parse(fs.readFileSync(SCALE_CONFIG_FILE, 'utf8')) as PersistedScaleConfig;
  } catch {
    return {};
  }
}

function persistConfig(cfg: PersistedScaleConfig): void {
  try {
    fs.writeFileSync(SCALE_CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error('Could not persist scale config:', err);
  }
}

const persistedScaleConfig = loadPersistedConfig();

export const DEFAULT_PORT_PATH =
  process.env.SCALE_PORT || persistedScaleConfig.port || DEFAULT_SCALE_PORT;
export const DEFAULT_BAUD_RATE = Number(
  process.env.SCALE_BAUD_RATE || persistedScaleConfig.baudRate || 9600,
);

export const SUPPORTED_BAUD_RATES = [
  1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200,
];

const STABLE_SAMPLES = 3;
const MAX_BUFFER_LENGTH = 512;

/**
 * How long a frame stays believable after it arrives. The poll cadence is
 * 100ms, so a second without a single reply means the machine has stopped
 * talking to us. Anything the client reads after that is a leftover, and a
 * leftover is exactly the value that would let an empty pan be accepted as a
 * full one.
 */
const READING_MAX_AGE_MS = 2000;

/**
 * This scale is a request/response device, not a streaming one: it stays
 * completely silent until something is written to it, then answers with
 * exactly one frame. Listening passively therefore only ever catches the
 * occasional spontaneous frame, which reads on screen as a one to two second
 * delay. Polling at a fixed cadence makes the displayed weight track the
 * machine in real time instead.
 *
 * Set SCALE_POLL_INTERVAL_MS=0 for a scale that streams on its own.
 */
const POLL_INTERVAL_MS = Number(process.env.SCALE_POLL_INTERVAL_MS ?? 100);
const POLL_BYTE = process.env.SCALE_POLL_BYTE || '?';

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export interface ScaleServiceOptions {
  portPath?: string;
  baudRate?: number;
  reconnectMs?: number;
}

/** Just enough of a serialport instance for this service to drive one. */
interface PortLike {
  isOpen: boolean;
  write(data: string, callback?: (err?: Error | null) => void): void;
  open(callback?: (err?: Error | null) => void): void;
  close(callback?: (err?: Error) => void): void;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  removeAllListeners(): unknown;
}

type SerialPortCtor = (new (options: Record<string, unknown>) => PortLike) & {
  list?: () => Promise<Array<{ path?: string }>>;
};

/** serialport is an optional native dependency: resolve it lazily so the API
 *  server still boots on machines without it (build servers, CI, phones). */
async function loadSerialPort(): Promise<SerialPortCtor | null> {
  try {
    const mod = (await import('serialport')) as unknown as {
      SerialPort?: SerialPortCtor;
    };
    return mod.SerialPort ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads a YH-T7E (YAOHUA) weighing scale over a serial port and publishes the
 * live reading. Emits:
 *   'reading' -> ScaleReading
 *   'status'  -> ScaleStatusInfo
 *
 * The port is opened lazily and retried automatically while the service is
 * running, so unplugging and replugging the scale recovers on its own.
 */
export class ScaleService extends EventEmitter {
  private portPath: string;
  private baudRate: number;
  private readonly reconnectMs: number;
  private status: ScaleStatus = 'stopped';
  private message: string | null = null;
  private since: string | null = null;
  private port: PortLike | null = null;
  private buffer = '';
  private reading: ScaleReading | null = null;
  private recentSamples: number[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private started = false;
  private bytesReceived = 0;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(options: ScaleServiceOptions = {}) {
    super();
    this.portPath = options.portPath ?? DEFAULT_PORT_PATH;
    this.baudRate = options.baudRate ?? DEFAULT_BAUD_RATE;
    this.reconnectMs = options.reconnectMs ?? 2000;
  }

  /** True while the service is trying to keep the port open. */
  get isRunning(): boolean {
    return this.started;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.kickOpen();
  }

  /**
   * open() runs detached from start() and the reconnect timer. Node treats an
   * unhandled rejection as fatal, so a single failed reopen would otherwise
   * kill the server that owns the only connection to the scale.
   */
  private kickOpen(): void {
    void this.open().catch((err: unknown) => {
      console.error('Scale open failed:', err);
      this.onPortError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  stop(): void {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closePort();
    this.resetStream();
    this.setStatus('stopped', 'Scale service stopped');
  }

  /**
   * Point the service at a different port/baud and (re)open. Passing null for
   * either keeps the current value.
   */
  async configure({
    portPath,
    baudRate,
  }: { portPath?: string | null; baudRate?: number | null } = {}): Promise<ScaleStatusInfo> {
    const nextPath = portPath ?? this.portPath;
    const nextBaud = Number(baudRate) || this.baudRate;
    const changed = nextPath !== this.portPath || nextBaud !== this.baudRate;
    this.portPath = nextPath;
    this.baudRate = nextBaud;
    // Remember the last selected port/baud for the next server start.
    persistConfig({ port: nextPath, baudRate: nextBaud });
    if (changed) {
      this.resetStream();
      if (this.started) {
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        await this.open();
      } else {
        this.setStatus('stopped', 'Scale service stopped');
      }
    }
    return this.getStatus();
  }

  private resetStream(): void {
    this.buffer = '';
    this.reading = null;
    this.recentSamples = [];
    this.bytesReceived = 0;
  }

  snapshot(): { status: ScaleStatusInfo; reading: ScaleReading | null } {
    return { status: this.statusInfo(), reading: this.reading };
  }

  getStatus(): ScaleStatusInfo {
    return this.statusInfo();
  }

  async listPorts(): Promise<string[]> {
    const SerialPort = await loadSerialPort();
    if (!SerialPort?.list) return [];
    const entries = await SerialPort.list();
    return entries
      .map((entry) => entry.path)
      .filter((port): port is string => Boolean(port));
  }

  getReading(): ScaleReading | null {
    // A reading only describes the pan while the machine keeps sending. A
    // scale switched into menu mode, unplugged at the far end, or with a
    // wedged USB-serial link leaves the port open and the bytes flowing
    // outbound while nothing ever comes back, so the status stays 'connected'
    // and the last frame would otherwise be served as a live weight forever.
    const reading = this.reading;
    if (!reading) return null;
    const age = Date.now() - Date.parse(reading.receivedAt);
    if (!Number.isFinite(age) || age > READING_MAX_AGE_MS) return null;
    return reading;
  }

  isDeviceConnected(): boolean {
    return this.status === 'connected';
  }

  private statusInfo(): ScaleStatusInfo {
    return {
      status: this.status,
      port: this.portPath,
      baudRate: this.baudRate,
      message: this.message,
      since: this.since,
      bytesReceived: this.bytesReceived,
      pollIntervalMs: POLL_INTERVAL_MS > 0 ? POLL_INTERVAL_MS : 0,
    };
  }

  private async open(): Promise<void> {
    if (!this.started) return;
    this.closePort();
    this.buffer = '';
    // Snapshotted before the awaits below. Reading this.portPath afterwards
    // meant two concurrent connects could both open a handle: the first to
    // resume would find the second's path had overwritten it, open a second
    // port and leave the other handle orphaned with its listeners still
    // attached, so readings kept arriving from a port nothing could close.
    const path = this.portPath;
    const baud = this.baudRate;
    // The last reading and its sample window belong to the old port. Kept, a
    // scale that reconnected to the same physical load would report the very
    // first frame as stable, having never re-settled.
    this.reading = null;
    this.recentSamples = [];
    this.setStatus('connecting', `Opening ${path} at ${baud} baud…`);

    const SerialPort = await loadSerialPort();
    if (!SerialPort) {
      this.onPortError(
        new Error('the serialport package is not installed — run `npm install`'),
      );
      return;
    }
    if (!this.started) return;

    try {
      const port = new SerialPort({
        path,
        baudRate: baud,
        autoOpen: false,
      });
      this.port = port;
      port.on('data', (chunk: Buffer) => this.onData(chunk));
      port.on('error', (err: Error) => this.onPortError(err));
      port.on('close', () => this.onPortClosed());
      port.open((err?: Error | null) => {
        if (!this.started) return;
        if (err) {
          this.onPortError(err);
          return;
        }
        this.setStatus('connected', null);
        this.startPolling();
      });
    } catch (err) {
      this.onPortError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private onData(chunk: Buffer): void {
    this.bytesReceived += chunk.length;
    this.buffer += chunk.toString('ascii');
    if (this.buffer.length > MAX_BUFFER_LENGTH) {
      this.buffer = this.buffer.slice(-MAX_BUFFER_LENGTH);
    }
    if (!this.buffer.includes(YAOHUA_START_CHAR)) {
      // No frame start in sight: keep a short tail so a '=' split across two
      // chunks is still caught, and drop the rest as junk.
      if (this.buffer.length > 32) this.buffer = this.buffer.slice(-16);
      return;
    }
    while (this.buffer.includes(YAOHUA_START_CHAR)) {
      const start = this.buffer.indexOf(YAOHUA_START_CHAR);
      if (this.buffer.length - start < YAOHUA_FRAME_LENGTH) break;
      const frame = this.buffer.slice(start, start + YAOHUA_FRAME_LENGTH);
      this.buffer = this.buffer.slice(start + YAOHUA_FRAME_LENGTH);
      const weight = parseYaohuaFrame(frame);
      if (weight !== null) this.pushReading(weight, frame);
    }
  }

  private pushReading(weight: number, raw: string): void {
    const rounded = round3(weight);
    this.recentSamples.push(rounded);
    if (this.recentSamples.length > STABLE_SAMPLES) this.recentSamples.shift();
    const stable =
      this.recentSamples.length >= STABLE_SAMPLES &&
      this.recentSamples.every((sample) => sample === rounded);
    this.reading = {
      weight: rounded,
      raw,
      receivedAt: new Date().toISOString(),
      stable,
    };
    this.emit('reading', this.reading);
  }

  private onPortError(err: Error): void {
    const code = (err as NodeJS.ErrnoException).code;
    const details = code ? `${err.message} (${code})` : err.message || String(err);
    this.closePort();
    // Symmetric with onPortClosed, and deliberately so. On Linux a USB
    // disconnect usually surfaces as a read error before the close event, and
    // whichever fired first used to decide whether the sample window was
    // wiped. When the error path left it intact, the first frame after a
    // reconnect could be reported as already stable.
    this.resetStream();
    // The raw driver message names filesystem paths and device internals, and
    // it reaches every client on the LAN. The operator only needs to know the
    // scale is not answering; the detail belongs in the server log.
    console.error(`Scale port error: ${details}`);
    this.setStatus('failed', 'Scale not available. Check the cable and rescan.');
    this.scheduleReconnect();
  }

  private onPortClosed(): void {
    this.closePort();
    this.resetStream();
    if (!this.started) return;
    this.setStatus('reconnecting', `Waiting for ${this.portPath}…`);
    this.scheduleReconnect();
  }

  private setStatus(status: ScaleStatus, message: string | null): void {
    this.status = status;
    this.message = message;
    this.since = status === 'connected' ? new Date().toISOString() : null;
    this.emit('status', this.statusInfo());
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.kickOpen();
    }, this.reconnectMs);
  }

  /**
   * Ask the scale for a reading on a fixed cadence. The device only replies to
   * a request, so without this the UI would trail the machine by seconds.
   */
  private startPolling(): void {
    this.stopPolling();
    if (!POLL_INTERVAL_MS || POLL_INTERVAL_MS <= 0) return;
    // Fire immediately so the first reading does not wait a full interval.
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private poll(): void {
    const port = this.port;
    if (!port || !port.isOpen) return;
    try {
      port.write(POLL_BYTE);
    } catch {
      // A failed write surfaces through the port error handler.
    }
  }

  private closePort(): void {
    this.stopPolling();
    const port = this.port;
    this.port = null;
    if (!port) return;
    try {
      port.removeAllListeners();
      if (port.isOpen) port.close();
    } catch {
      // port already gone
    }
  }
}
