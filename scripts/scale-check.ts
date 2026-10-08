#!/usr/bin/env node
/**
 * Weighing scale diagnostic.
 *
 * Proves whether a serial port is actually talking to the scale, and if not,
 * narrows down why. Run it before blaming the app:
 *
 *   npm run scale:check                 # every port, every common setting
 *   npm run scale:check -- /dev/ttyUSB1 # one port
 *
 * A healthy scale streams 8-character YH-T7E frames that begin with '='.
 * Anything reported as "noise" means bytes moved but none of them were
 * readable weight frames — a wiring, cable-type or baud-rate problem.
 */
import { createRequire } from 'node:module';
import {
  parseYaohuaFrame,
  YAOHUA_FRAME_LENGTH as FRAME_LENGTH,
  YAOHUA_START_CHAR,
} from '../server/scale/yaohua.ts';

const require = createRequire(import.meta.url);

type SerialPortCtor = new (options: Record<string, unknown>) => SerialPortHandle;

interface SerialPortHandle {
  isOpen: boolean;
  open(callback?: (err?: Error | null) => void): void;
  close(callback?: (err?: Error) => void): void;
  write(data: string): void;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  removeAllListeners(): unknown;
}

interface PortDescriptor {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
}

interface AttemptResult {
  error?: string;
  bytes?: number;
  printable?: number;
  eqCount?: number;
  weights?: number[];
  raw?: Buffer;
}

interface Formatter {
  label: string;
  dataBits: number;
  stopBits: number;
  parity: 'none' | 'even' | 'odd';
}

interface PortSettings extends Formatter {
  baudRate: number;
}

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
const FORMATS: Formatter[] = [
  { label: '8N1', dataBits: 8, stopBits: 1, parity: 'none' },
  { label: '7E1', dataBits: 7, stopBits: 1, parity: 'even' },
  { label: '7O1', dataBits: 7, stopBits: 1, parity: 'odd' },
];
const LISTEN_MS = 2500;

/**
 * This scale only answers when spoken to, so a passive listen can report a
 * perfectly healthy port as "noise". Send the same request the app sends while
 * sampling so the result reflects what the app will actually see.
 */
const POLL_BYTE = process.env.SCALE_POLL_BYTE || '?';
const POLL_MS = Number(process.env.SCALE_POLL_INTERVAL_MS ?? 100);

function tryOpen(SerialPort: SerialPortCtor, portPath: string, options: PortSettings) {
  return new Promise<AttemptResult>((resolve) => {
    let bytes = 0;
    let printable = 0;
    let eqCount = 0;
    const raw: Buffer[] = [];
    const weights: number[] = [];
    let text = '';
    let pollTimer: NodeJS.Timeout | null = null;
    let port: SerialPortHandle;
    try {
      port = new SerialPort({ path: portPath, autoOpen: false, ...options });
    } catch (err) {
      resolve({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const done = (result: AttemptResult) => {
      if (pollTimer) clearInterval(pollTimer);
      try {
        port.removeAllListeners();
        if (port.isOpen) port.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };
    port.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (raw.length < 64) raw.push(Buffer.from(chunk));
      for (const b of chunk) {
        if (b >= 0x20 && b < 0x7f) printable += 1;
        if (b === 0x3d) eqCount += 1;
      }
      text += chunk.toString('ascii');
      if (text.length > 512) text = text.slice(-256);
      let from = 0;
      for (;;) {
        const start = text.indexOf(YAOHUA_START_CHAR, from);
        if (start < 0) break;
        if (text.length - start < FRAME_LENGTH) break;
        const weight = parseYaohuaFrame(text.slice(start, start + FRAME_LENGTH));
        if (weight !== null) weights.push(weight);
        from = start + FRAME_LENGTH;
      }
    });
    port.on('error', (err: Error) => done({ error: err.message }));
    port.open((err?: Error | null) => {
      if (err) {
        done({ error: err.message });
        return;
      }
      if (POLL_MS > 0) {
        try {
          port.write(POLL_BYTE);
        } catch {
          /* write failure surfaces via the error handler */
        }
        pollTimer = setInterval(() => {
          try {
            port.write(POLL_BYTE);
          } catch {
            /* ignore */
          }
        }, POLL_MS);
      }
      setTimeout(
        () => done({ bytes, printable, eqCount, weights, raw: Buffer.concat(raw) }),
        LISTEN_MS,
      );
    });
  });
}

async function main() {
  let SerialPort: SerialPortCtor;
  try {
    ({ SerialPort } = require('serialport'));
  } catch {
    console.error('The serialport package is not installed. Run `npm install` first.');
    process.exit(1);
  }

  const requested = process.argv[2];
  let ports: PortDescriptor[];
  try {
    ports = (await (SerialPort as unknown as {
      list: () => Promise<PortDescriptor[]>;
    }).list());
  } catch (err) {
    console.error('Could not enumerate serial ports:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (!ports.length) {
    console.log('No serial ports found. The USB adapter is not detected at all.');
    process.exit(1);
  }

  const targets = requested
    ? ports.filter((p) => p.path === requested)
    : ports.filter((p) => /ttyUSB|ttyACM|ttyS[0-9]?$/.test(p.path));

  if (requested && !targets.length) {
    console.log(`Port ${requested} not found. Available:`);
    for (const p of ports) console.log(`  ${p.path}${p.manufacturer ? ` — ${p.manufacturer}` : ''}`);
    process.exit(1);
  }

  console.log(`Listening ${LISTEN_MS / 1000}s per setting. This takes a while — be patient.\n`);

  let healthy = 0;
  for (const target of targets) {
    console.log(`=== ${target.path}${target.manufacturer ? ` — ${target.manufacturer}` : ''}`);
    let opened = 0;
    for (const format of FORMATS) {
      for (const baudRate of BAUD_RATES) {
        const result = await tryOpen(SerialPort, target.path, { ...format, baudRate });
        if (result.error) {
          console.log(`  ${format.label} @ ${String(baudRate).padStart(6)}  cannot open: ${result.error}`);
          continue;
        }
        opened += 1;
        if (!result.bytes) continue;

        const rawBuffer = result.raw ?? Buffer.alloc(0);
        const printablePct = Math.round(((result.printable ?? 0) / result.bytes) * 100);
        const frames = result.weights ?? [];
        const text = rawBuffer.toString('latin1');
        const verdict = frames.length
          ? `OK  ${frames.length} frame(s): ${frames.slice(0, 6).map((w) => `${w} kg`).join(', ')}`
          : printablePct > 80
            ? 'text but not YH-T7E frames'
            : 'noise';
        console.log(
          `  ${format.label} @ ${String(baudRate).padStart(6)}  ${String(result.bytes).padStart(5)}B` +
            `  printable ${String(printablePct).padStart(3)}%  '=' ${result.eqCount ?? 0}  ${verdict}`,
        );
        if (frames.length) {
          console.log(`         raw: ${JSON.stringify(text.slice(0, 48))}`);
          healthy += 1;
        }
      }
    }
    if (opened === 0) console.log('  port could not be opened in any configuration');
    console.log('');
  }

  if (healthy > 0) {
    console.log('RESULT: a working scale was found. Use the matching settings in the app.');
    return;
  }

  console.log('RESULT: no valid weight frames on any port or setting.');
  console.log('');
  console.log('The port opens, so this is a hardware problem, not a software one. Check:');
  console.log('  1. The scale is powered on and showing a reading.');
  console.log('  2. The cable is a true RS232 DB9 cable. A USB-TTL "phone data" cable');
  console.log('     (Prolific/CH340 phone cables) does NOT work with an RS232 scale —');
  console.log('     you need a USB-RS232 adapter with a level shifter.');
  console.log('  3. TX and RX are not swapped in the DB9 wiring.');
  console.log('  4. If the scale has a config menu, confirm the output format is');
  console.log('     YH-T7E continuous mode at the baud rate you selected.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
