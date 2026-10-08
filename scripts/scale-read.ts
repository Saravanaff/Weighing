#!/usr/bin/env node
/**
 * Standalone scale reader — tests the physical connection and weight reading
 * without involving the app or the API server.
 *
 *   node scripts/scale-read.ts                     the default port @ 9600
 *   node scripts/scale-read.ts /dev/ttyS1           a different port
 *   node scripts/scale-read.ts /dev/ttyS1 19200     a different port and baud
 *   node scripts/scale-read.ts --scan               try every baud rate
 *   node scripts/scale-read.ts --no-poll            don't request readings
 *   node scripts/scale-read.ts /dev/ttyS1 9600 --poll 200
 *                                                     request every 200ms
 *
 * This scale answers one frame per request, so polling is on by default at
 * 100ms. That saturates its ~10 readings/sec ceiling; polling faster does not
 * help. Use --no-poll for a scale that streams unprompted.
 *
 * Stop `npm run dev:all` first — the API server holds the port exclusively
 * and this script will report "Cannot lock port" otherwise.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { DEFAULT_SCALE_PORT } from '../shared/scale.ts';
import {
  parseYaohuaFrame,
  YAOHUA_FRAME_LENGTH as FRAME_LENGTH,
  YAOHUA_START_CHAR,
} from '../server/scale/yaohua.ts';

const require = createRequire(import.meta.url);
const DEFAULT_POLL_MS = 100;

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
const SILENCE_LIMIT_MS = 15000;

type SerialPortCtor = new (options: Record<string, unknown>) => SerialPortHandle;

interface SerialPortHandle {
  isOpen: boolean;
  open(callback?: (err?: Error | null) => void): void;
  close(callback?: (err?: Error) => void): void;
  write(data: string): void;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

interface PortDescriptor {
  path: string;
  manufacturer?: string;
}

interface ListenOptions {
  onFrame: (weight: number, frame: string) => void;
  onJunk: (frame: string) => void;
  pollMs: number;
  pollByte?: string;
}

// Protocol: YH-T7E (YAOHUA) — see server/scale/yaohua.ts for the format.
const bold = (s: string) => `\u001b[1m${s}\u001b[0m`;
const green = (s: string) => `\u001b[32m${s}\u001b[0m`;
const red = (s: string) => `\u001b[31m${s}\u001b[0m`;
const dim = (s: string) => `\u001b[2m${s}\u001b[0m`;
const yellow = (s: string) => `\u001b[33m${s}\u001b[0m`;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function loadSerialPort(): SerialPortCtor {
  try {
    return (require('serialport') as { SerialPort: SerialPortCtor }).SerialPort;
  } catch {
    console.error(red('The serialport package is not installed. Run `npm install` first.'));
    process.exit(1);
  }
}

function openPort(SerialPort: SerialPortCtor, path: string, baudRate: number) {
  return new Promise<SerialPortHandle>((resolve, reject) => {
    const port = new SerialPort({ path, baudRate, autoOpen: false });
    port.open((err) => (err ? reject(err) : resolve(port)));
  });
}

function listen(port: SerialPortHandle, { onFrame, onJunk, pollMs, pollByte = '?' }: ListenOptions) {
  let buffer = '';
  let frameCount = 0;
  let junkCount = 0;
  let bytes = 0;
  let lastDataAt = Date.now();

  port.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    lastDataAt = Date.now();
    buffer += chunk.toString('ascii');
    while (buffer.includes(YAOHUA_START_CHAR)) {
      const start = buffer.indexOf(YAOHUA_START_CHAR);
      if (buffer.length - start < FRAME_LENGTH) break;
      const frame = buffer.slice(start, start + FRAME_LENGTH);
      buffer = buffer.slice(start + FRAME_LENGTH);
      const weight = parseYaohuaFrame(frame);
      if (weight === null) {
        junkCount += 1;
        onJunk(frame);
      } else {
        frameCount += 1;
        onFrame(weight, frame);
      }
    }
  });

  let pollTimer: NodeJS.Timeout | null = null;
  if (pollMs) {
    port.write(pollByte);
    pollTimer = setInterval(() => {
      if (port.isOpen) port.write(pollByte);
    }, pollMs);
  }

  const silenceTimer = setInterval(() => {
    if (Date.now() - lastDataAt > SILENCE_LIMIT_MS) {
      console.log(
        `\n${yellow('No data for 15s — the scale is not transmitting.')}` +
          `\n${dim('Received nothing at all. Check the cable and power.')}`,
      );
      process.exit(0);
    }
  }, 1000);

  const stop = () => {
    clearInterval(silenceTimer);
    if (pollTimer) clearInterval(pollTimer);
  };

  return {
    stats: () => ({ frameCount, junkCount, bytes }),
    stop,
  };
}

function listPorts(SerialPort: SerialPortCtor): Promise<PortDescriptor[]> {
  return (SerialPort as unknown as { list: () => Promise<PortDescriptor[]> }).list();
}

async function printHelp(SerialPort: SerialPortCtor) {
  console.log(bold('\nAvailable serial ports:\n'));
  try {
    const ports = await listPorts(SerialPort);
    if (!ports.length) {
      console.log(red('  No serial ports found. The USB adapter is not detected.'));
    }
    for (const p of ports) {
      const tag = /ttyUSB|ttyACM/.test(p.path) ? 'USB ' : '    ';
      console.log(`  ${tag}${p.path}${p.manufacturer ? `  — ${p.manufacturer}` : ''}`);
    }
    console.log(dim('\nUsage: npm run scale:read -- [port] [baud] [--scan] [--no-poll]\n'));
  } catch (err) {
    console.error(red(errText(err)));
    process.exit(1);
  }
}

async function runSingle(SerialPort: SerialPortCtor, path: string, baudRate: number, pollMs: number) {
  console.log(
    bold(`\nOpening ${path} at ${baudRate} baud…\n`) +
      (pollMs ? dim(`Requesting a reading every ${pollMs}ms.\n`) : dim('Listening only (no polling).\n')),
  );
  let port: SerialPortHandle;
  try {
    port = await openPort(SerialPort, path, baudRate);
  } catch (err) {
    if (errText(err).includes('lock')) {
      console.error(
        red('\nCannot lock port — something else already has it open.'),
        '\nStop the app first:  Ctrl+C in the dev:all terminal\n',
      );
    } else {
      console.error(red(`\nCould not open ${path}: ${errText(err)}\n`));
    }
    process.exit(1);
  }

  console.log(green('Connected.'), dim('Waiting for weight frames…\n'));

  const { stats, stop } = listen(port, {
    onFrame: (weight: number, frame: string) => {
      console.log(
        `  ${bold(weight.toFixed(3).padStart(9))} kg   ${dim(`frame ${JSON.stringify(frame)}`)}`,
      );
    },
    onJunk: (frame: string) => {
      if (stats().junkCount <= 5) {
        console.log(dim(`  (ignored unparseable ${JSON.stringify(frame)})`));
      }
    },
    pollMs,
  });

  process.on('SIGINT', () => {
    const s = stats();
    console.log(
      `\n${bold('Summary')}  ${s.frameCount} valid frame(s), ` +
        `${s.junkCount} rejected, ${s.bytes} byte(s) total`,
    );
    stop();
    port.close(() => process.exit(0));
  });
}

async function runScan(SerialPort: SerialPortCtor, path: string, pollMs: number) {
  console.log(
    bold(`\nScanning ${path} across all baud rates (3s each)…\n`) +
      dim(pollMs ? `Requesting a reading every ${pollMs}ms.\n` : 'Listening only (no polling).\n'),
  );
  let winner: number | null = null;

  for (const baudRate of BAUD_RATES) {
    let frames = 0;
    let bytes = 0;
    const found: string[] = [];
    let port: SerialPortHandle;
    try {
      port = await openPort(SerialPort, path, baudRate);
    } catch (err) {
      console.log(`  ${String(baudRate).padStart(6)}  ${red(errText(err))}`);
      continue;
    }
    const handle = listen(port, {
      onFrame: (w: number) => {
        frames += 1;
        if (found.length < 3) found.push(`${w} kg`);
      },
      onJunk: (): void => {},
      pollMs,
    });
    port.on('data', (c: Buffer) => {
      bytes += c.length;
    });

    await new Promise((r) => setTimeout(r, 3000));
    handle.stop();
    port.close();
    await new Promise((r) => setTimeout(r, 150));

    const mark = frames > 0 ? green('OK') : bytes > 0 ? yellow('noise') : dim('silent');
    console.log(
      `  ${String(baudRate).padStart(6)}  ${String(bytes).padStart(6)}B  ` +
        `${mark}${frames ? `  ${frames} frame(s): ${found.join(', ')}` : ''}`,
    );
    if (frames > 0 && !winner) winner = baudRate;
  }

  console.log('');
  if (winner) {
    console.log(green(`Result: the scale answers at ${winner} baud.`));
    console.log(dim(`\n  npm run scale:read -- ${path} ${winner}\n`));
  } else {
    console.log(red('Result: no valid weight frames at any baud rate.'));
    console.log(red(`\n  The port opened but no frame decoded. Check, in order:\n`));
    console.log(dim('   1. The scale is powered on and showing a reading.'));
    console.log(dim('   2. The request is reaching it — compare `--poll 200` with'));
    console.log(dim('      `--no-poll`, since it only answers a request.'));
    console.log(dim('   3. The cable is true RS232 (DB9); a USB-TTL "phone data"'));
    console.log(dim('      cable cannot read an RS232 scale.'));
    console.log(dim('   4. TX and RX are not swapped in the DB9 wiring.'));
    console.log('');
  }
}

async function main() {
  const SerialPort = loadSerialPort();
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      dim('\nUsage: npm run scale:read -- [port] [baud] [--scan] [--no-poll] [--poll MS]\n'),
    );
    return;
  }

  const ports = await listPorts(SerialPort);
  if (!ports.length) {
    console.log(red('\nNo serial ports found. The USB adapter is not detected.\n'));
    process.exit(1);
  }

  const positional = args.filter((a) => !a.startsWith('--'));
  const scan = args.includes('--scan');
  const pollIndex = args.indexOf('--poll');
  const pollMs = args.includes('--no-poll')
    ? 0
    : pollIndex !== -1
      ? Number(args[pollIndex + 1]) || DEFAULT_POLL_MS
      : DEFAULT_POLL_MS;

  // The app reads one fixed port, so the diagnostic defaults to the same one.
  // Auto-picking a USB adapter here would test a different port than the shop
  // actually uses, which is a confusing way to be told the scale is fine.
  const port: string =
    positional[0] ||
    DEFAULT_SCALE_PORT ||
    (ports.find((p) => p.path === DEFAULT_SCALE_PORT) || ports[0]).path;
  const baudRate = Number(positional[1]) || 9600;

  if (!ports.some((p) => p.path === port)) {
    // Not enumerated (PTYs, some FTDI units) — still worth a try if the path
    // actually exists on disk.
    if (!existsSync(port)) {
      await printHelp(SerialPort);
      return;
    }
    console.log(yellow(`Note: ${port} is not in the enumerated list, trying anyway.\n`));
  }

  if (scan) {
    await runScan(SerialPort, port, pollMs);
    return;
  }

  await runSingle(SerialPort, port, baudRate, pollMs);
}

main().catch((err) => {
  console.error(red(errText(err)));
  process.exit(1);
});
