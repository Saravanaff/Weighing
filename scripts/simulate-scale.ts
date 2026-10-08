#!/usr/bin/env node
/**
 * Virtual YH-T7E weighing scale.
 *
 * Stands in for the real machine on a machine that has no scale attached. It
 * creates a pair of linked pseudo-terminals with socat and speaks the real
 * frame protocol on one end, so the app opens it as an ordinary serial port and
 * nothing in server/ or src/ knows the difference. That is the point: this
 * exercises the frame parser, the polling loop, the stable-sample window and the
 * SSE stream, not a shortcut around them.
 *
 *   npm run scale:sim
 *   npm run scale:sim -- --zero -0.5      # start reading 0.5 kg BELOW zero
 *   npm run scale:sim -- --port /dev/ttyS9
 *
 * Then in the app, connect the scale on the printed port at 9600 baud.
 *
 * Type weights on the prompt to move the simulated pan:
 *
 *   50          pan now holds 50 kg (an ABSOLUTE reading, replace the pan)
 *   +50         add 50 kg to whatever is already on the pan
 *   50,50.4,50.5  step the pan through each weight in turn, 3 s apart
 *   -0.5        take 0.5 kg off
 *   zero        empty the pan, exactly 0.000
 *   drift 0.2   make the pan wander by ±0.2 kg, like a real load cell
 *   noise 0.05  jitter of ±0.05 kg on every poll
 *   silent 3    stop answering for 3 s, then resume
 *   noise on|off / drift on|off / silent on
 *   pause       stop sending without going quiet, to test staleness
 *   help
 *
 * Ctrl-C closes both ends.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const START_CHAR = '=';
const DEFAULT_ZERO = 0;

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const requestedPort = flag('port', '');
const startZero = Number(flag('zero', String(DEFAULT_ZERO)));

/**
 * Encode a weight as an 8 character YH-T7E frame.
 *
 *   '=' + 6 digit characters + 1 sign character
 *
 * The six digits are reversed, and the decimal point sits at a fixed position,
 * so the largest reading the frame can carry is 999.99 kg. Anything outside that
 * is reported rather than silently truncated, because a truncated frame would
 * look to the app like a plausible weight.
 */
function encodeFrame(weight: number): string | null {
  if (!Number.isFinite(weight)) return null;
  if (Math.abs(weight) > 999.99) return null;
  const negative = weight < 0;
  const [whole, fraction = ''] = Math.abs(weight).toFixed(2).split('.');
  const digits = `${whole.padStart(3, '0')}.${fraction.padEnd(2, '0').slice(0, 2)}`;
  if (digits.length !== 6) return null;
  const reversed = digits.split('').reverse().join('');
  return `${START_CHAR}${reversed}${negative ? '-' : '+'}`;
}

function parseFlag(arg: string): [string, string | null] {
  const m = /^([a-z]+)(?:\s+(.+))?$/i.exec(arg.trim());
  if (!m) return [arg.trim().toLowerCase(), null];
  return [m[1].toLowerCase(), m[2] ?? null];
}

/**
 * socat creates the pseudo-terminal and bridges its own stdin/stdout onto it, so
 * this script talks to the wire through socat's stdio while the app opens the
 * linked device. Naming it with link= matters: an app pointed at a raw /dev/pts/N
 * from an earlier run finds a dead device once that run exits, because the kernel
 * reuses those numbers and frees the old one.
 */
const linkPath = requestedPort || '/tmp/koushi-scale-sim';
const socat = spawn(
  'socat',
  ['-d', '-d', `pty,raw,echo=0,link=${linkPath}`, '-'],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);

const serverPath = linkPath;
let pendingStderr = '';

socat.stderr.on('data', (chunk: Buffer) => {
  pendingStderr += chunk.toString();
});

socat.on('error', (err: Error) => {
  console.error('Could not start socat:', err.message);
  console.error('socat is needed to create a virtual serial port.');
  process.exit(1);
});

socat.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error(`socat exited with code ${code}.`);
    if (pendingStderr.trim()) console.error(pendingStderr.trim());
    process.exit(1);
  }
});

/**
 * Wait for the link to exist. socat creates the device a moment after launch, and
 * the app cannot open it before then.
 */
async function waitForPort(path: string, timeoutMs = 5000): Promise<string> {
  const started = Date.now();
  for (;;) {
    if (existsSync(path)) return path;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`socat did not create ${path} in time`);
    }
    await sleep(50);
  }
}

const pan = {
  /** The weight currently on the pan, as the scale would report it. */
  reading: Number.isFinite(startZero) ? startZero : DEFAULT_ZERO,
  /** Peak-to-peak wander in kg, like a load cell that never sits perfectly still. */
  drift: 0,
  /** Random jitter added on each poll, in kg. */
  noise: 0,
  /** Stop answering for this many seconds from now. */
  silentUntil: 0,
  /** Stop answering until told otherwise. */
  silent: false,
};

let driftPhase = 0;
let paused = false;

function nextReading(): number {
  let value = pan.reading;
  if (pan.drift > 0) {
    driftPhase += 0.35;
    value += Math.sin(driftPhase) * (pan.drift / 2);
  }
  if (pan.noise > 0) {
    value += (Math.random() * 2 - 1) * pan.noise;
  }
  return Math.round(value * 100) / 100;
}

function isSilent(): boolean {
  if (pan.silent) return true;
  return Date.now() < pan.silentUntil;
}

const help = `Virtual scale commands
  <number>       set the pan to an absolute weight, e.g. 50
  +<number>      add weight to the pan, e.g. +50
  -<number>      remove weight from the pan
  a,b,c          step the pan through each weight, 3 s apart, e.g. 50,50.4,50.5
  zero           empty the pan, exactly 0.000
  drift <kg>     make the pan wander by that much
  noise <kg>     jitter every reading by that much
  silent <secs>  stop answering for that long
  silent on|off  stop or resume answering
  noise on|off   turn jitter on or off
  drift on|off   turn wander on or off
  pause          stop sending, keep answering on Ctrl-C
  help           show this
`;

function applyCommand(line: string): void {
  const [cmd, arg] = parseFlag(line);
  if (cmd === 'help' || cmd === '?') return console.log(help);
  if (cmd === 'zero') {
    pan.reading = 0;
    return console.log('  pan emptied');
  }
  if (cmd === 'pause') {
    paused = true;
    return console.log('  sending paused, still holding the connection open');
  }
  if (cmd === 'drift' || cmd === 'noise') {
    if (arg === 'on' || arg === null) pan[cmd] = Math.max(pan[cmd], 0.1);
    else if (arg === 'off') pan[cmd] = 0;
    else {
      const n = Number(arg);
      if (!Number.isFinite(n) || n < 0) return console.log(`  ${cmd} needs a weight in kg`);
      pan[cmd] = n;
    }
    return console.log(`  ${cmd} = ${pan[cmd]} kg`);
  }
  if (cmd === 'silent') {
    if (arg === 'on') {
      pan.silent = true;
      return console.log('  going quiet');
    }
    if (arg === 'off') {
      pan.silent = false;
      pan.silentUntil = 0;
      return console.log('  answering again');
    }
    const secs = Number(arg);
    if (!Number.isFinite(secs) || secs < 0) return console.log('  silent needs seconds, or on/off');
    pan.silentUntil = Date.now() + secs * 1000;
    return console.log(`  quiet for ${secs}s`);
  }

  const signed = cmd.startsWith('+') || cmd.startsWith('-');
  const value = Number(signed ? cmd : arg ?? cmd);
  if (!Number.isFinite(value)) return console.log(`  did not understand "${line}" — try help`);
  if (Math.abs(value) > 999.99) {
    return console.log('  that frame cannot carry more than 999.99 kg');
  }
  pan.reading = signed ? round2(pan.reading + value) : value;
  console.log(`  pan = ${pan.reading.toFixed(2)} kg`);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Walk the pan through several weights, holding each long enough to settle. */
async function runSteps(numbers: number[]): Promise<void> {
  let previous = pan.reading;
  for (const next of numbers) {
    const delta = round2(next - previous);
    previous = next;
    // Ramp rather than jump, so the app sees the weight arrive rather than
    // teleport. A scale that teleports cannot be tested for settling.
    const steps = 10;
    for (let i = 1; i <= steps; i += 1) {
      pan.reading = round2(pan.reading + delta / steps);
      await sleep(30);
    }
    pan.reading = round2(next);
    console.log(`  pan = ${pan.reading.toFixed(2)} kg`);
    await sleep(3000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const path = await waitForPort(serverPath);
  // socat bridges the pty onto its own stdio, and the two directions are not
  // interchangeable: stdout carries what the app sends, stdin is what the app
  // will read. Writing a reply to stdout would send it back to whoever asked.
  const fromApp = socat.stdout;
  const toApp = socat.stdin;
  toApp?.on('error', () => {
    // The app closing the port is normal shutdown, not a failure worth printing.
  });

  console.log('Virtual YH-T7E scale');
  console.log(`  connect the app to:  ${path}`);
  console.log('  baud:                9600');
  console.log('  the app must be told to connect, it will not find this by itself');
  console.log('');
  console.log(help);
  console.log('');

  // This scale is request/response: stay silent until written to, exactly like
  // the real machine. A simulator that volunteers readings would hide the bug
  // where the app works passively but never when polled.
  fromApp.on('data', () => {
    if (paused) return;
    if (isSilent()) return;
    const frame = encodeFrame(nextReading());
    if (!frame) return;
    toApp?.write(frame);
  });

  const timer = setInterval(() => {
    if (pan.silent && Date.now() >= pan.silentUntil) {
      pan.silent = false;
      console.log('  answering again');
    }
  }, 200);

  const rl = createInterface({ input: process.stdin, prompt: 'scale> ' });
  rl.prompt();
  rl.on('line', async (line) => {
    if (line.trim()) {
      // A stepped walk is awaited so the next prompt lands after it finishes.
      await applyCommandAsync(line);
    }
    rl.prompt();
  });
  rl.on('close', shutdown);

  function shutdown(): void {
    clearInterval(timer);
    socat.kill('SIGTERM');
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function applyCommandAsync(line: string): Promise<void> {
  const steps = line.trim().split(',').map((s) => s.trim()).filter(Boolean);
  if (steps.length > 1 && steps.every((s) => Number.isFinite(Number(s)))) {
    await runSteps(steps.map(Number));
    return;
  }
  applyCommand(line);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  socat.kill('SIGTERM');
  process.exit(1);
});