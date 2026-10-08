/**
 * Types shared by the API server and both frontends.
 *
 * This is the contract for the scale endpoints: whatever the server publishes
 * and the UI reads back. Keeping it in one place means a change to the wire
 * format breaks the build on both sides instead of silently at runtime.
 */

/** Lifecycle of the serial connection to the weighing machine. */
export type ScaleStatus =
  | 'stopped'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

/** Default scale port used when the operating system has not reported ports. */
export const DEFAULT_SCALE_PORT = '/dev/ttyS1';

/** One decoded weight from the machine, in kilograms. */
export interface ScaleReading {
  weight: number;
  /** The exact 8 character frame as received, useful for diagnosing a scale. */
  raw: string;
  /** ISO timestamp of when the frame was parsed. */
  receivedAt: string;
  /** True once the last three frames all agreed. */
  stable: boolean;
}

export interface ScaleStatusInfo {
  status: ScaleStatus;
  port: string;
  baudRate: number;
  message: string | null;
  /** ISO timestamp of when the port opened. */
  since: string | null;
  bytesReceived: number;
  /** 0 when the scale streams on its own, otherwise the request cadence. */
  pollIntervalMs: number;
}

export interface ScaleSnapshot {
  status: ScaleStatusInfo;
  reading: ScaleReading | null;
}

export interface ScalePortsResponse {
  /** The port currently selected by the server. */
  port?: string;
  /** Serial ports currently visible to the operating system. */
  ports?: string[];
  baudRates: number[];
  /** False when the server was started with SCALE_ENABLED=0. */
  enabled?: boolean;
  current?: ScaleStatusInfo;
}

/**
 * What GET /api/scale/status returns: the public status (no poll internals)
 * plus the most recent reading, or null if none has arrived yet.
 */
export interface ScaleStatusResponse
  extends Omit<ScaleStatusInfo, 'pollIntervalMs'> {
  connected: boolean;
  reading: ScaleReading | null;
}

/** Server-sent event payloads on /api/scale/stream. */
export type ScaleStreamEvent =
  | { type: 'status'; status: ScaleStatusInfo }
  | { type: 'reading'; reading: ScaleReading };
