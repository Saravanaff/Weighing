import type { Request, Response } from 'express';
import type { ScaleReading, ScaleStatusInfo } from '../../shared/scale.ts';
import type { ScaleService } from './scaleService.ts';

type Handler = (req: Request, res: Response) => void;

/**
 * Writes to a client socket can fail (tablet sleeps, wifi drops, a browser tab
 * is killed mid-write). A throw inside an EventEmitter listener would escape
 * as an unhandled error and take the whole server down, so every write is
 * guarded and treated as a disconnect.
 */
function safeWrite(res: Response, chunk: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function sendEvent(res: Response, event: string, data: unknown): void {
  safeWrite(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** The shape the browser sees, which adds a convenience flag to the status. */
interface PublicScaleStatus extends Omit<ScaleStatusInfo, 'pollIntervalMs'> {
  connected: boolean;
}

function toPublicStatus(status: ScaleStatusInfo): PublicScaleStatus {
  return {
    connected: status.status === 'connected',
    status: status.status,
    port: status.port,
    baudRate: status.baudRate,
    message: status.message,
    since: status.since,
    bytesReceived: status.bytesReceived,
  };
}

/**
 * Creates an SSE handler that streams live scale status and readings to the
 * browser. The response is held open and EventSource retries natively.
 */
export function createScaleStreamHandler(service: ScaleService): Handler {
  return (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let open = true;
    const detach = () => {
      open = false;
      clearInterval(heartbeat);
      service.off('status', onStatus);
      service.off('reading', onReading);
    };
    const onStatus = (status: ScaleStatusInfo) => {
      if (open) sendEvent(res, 'status', toPublicStatus(status));
    };
    const onReading = (reading: ScaleReading) => {
      if (open) sendEvent(res, 'reading', reading);
    };
    const heartbeat = setInterval(() => {
      if (!open || !safeWrite(res, ': keep-alive\n\n')) detach();
    }, 15000);

    service.on('status', onStatus);
    service.on('reading', onReading);
    req.on('close', () => {
      detach();
      res.end();
    });

    // Paint the current state immediately so the client is never blank.
    onStatus(service.getStatus());
    const snapshot = service.getReading();
    if (snapshot) onReading(snapshot);
  };
}

/**
 * JSON handler for GET /api/scale/status — the current device state as a
 * single response (not a stream).
 */
export function createScaleStatusHandler(service: ScaleService): Handler {
  return (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(
      JSON.stringify({
        ...toPublicStatus(service.getStatus()),
        reading: service.getReading(),
      }),
    );
  };
}
