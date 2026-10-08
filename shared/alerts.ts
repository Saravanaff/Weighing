/**
 * Audible weight-band alerts for the weighing terminal.
 *
 * Tones are synthesised with the Web Audio API rather than shipped as files:
 * they start with zero latency, work offline inside the Android build, and —
 * unlike speech — do not cancel the item name that `tts.ts` is playing. The
 * three bands are deliberately different in pitch and shape so an operator can
 * tell them apart without looking at the screen:
 *
 *   underweight  two short mid tones rising   "not enough yet, add more"
 *   overweight   two low tones falling         "too much, take some off"
 *   accepted     three rising notes            "target reached"
 *
 * Under and over keep ringing on a loop for as long as the weight sits in that
 * band, so the operator never has to watch the screen to know they are still
 * off target; reaching the target silences the loop and confirms with a chime.
 */

/** Mirrors ReadingVerdictType so this module stays free of app-level imports. */
export type AlertKind = 'neutral' | 'accepted' | 'underweight' | 'overweight';

const STORAGE_KEY = 'naveen.alertsEnabled';

export function alertsEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    // Private mode / storage disabled: stay audible.
    return true;
  }
}

/** Volume: 0.0 (silent) to 1.0 (full). Persisted in localStorage. */
const VOLUME_KEY = 'naveen.alertVolume';
export function getAlertVolume(): number {
  if (typeof window === 'undefined') return 1;
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY);
    const n = raw == null ? null : Number(raw);
    if (n == null || !Number.isFinite(n)) return master ? master.gain.value : 1;
    return Math.max(0, Math.min(1, n));
  } catch {
    return master ? master.gain.value : 1;
  }
}

export function setAlertVolume(v: number): void {
  const clamped = Math.max(0, Math.min(1, Number(v) || 0));
  try {
    window.localStorage.setItem(VOLUME_KEY, String(clamped));
  } catch {}
  if (master) master.gain.value = clamped;
}

export function setAlertsEnabled(on: boolean): boolean {
  // Unmuting must not stay silent: the loop was torn down when it was muted,
  // so re-arm it from whatever band is currently on screen.
  if (on) {
    try {
      window.localStorage.setItem(STORAGE_KEY, 'on');
    } catch {
      // storage disabled: audible for this session anyway
    }
    if (desiredKind !== 'neutral' && desiredKind !== 'accepted') {
      currentKind = 'neutral';
      setAlertLoop(desiredKind);
    }
    return true;
  }
  stopAlertLoop();
  try {
    window.localStorage.setItem(STORAGE_KEY, 'off');
  } catch {
    // Ignore: the setting simply will not persist across reloads.
  }
  return false;
}

export function toggleAlertsEnabled(): boolean {
  return setAlertsEnabled(!alertsEnabled());
}

type Tone = { freq: number; at: number; duration: number; peak: number };

const SOUNDS: Record<Exclude<AlertKind, 'neutral'>, Tone[]> = {
  underweight: [
    { freq: 784, at: 0, duration: 0.1, peak: 0.2 },
    { freq: 988, at: 0.12, duration: 0.14, peak: 0.2 },
  ],
  overweight: [
    { freq: 220, at: 0, duration: 0.16, peak: 0.34 },
    { freq: 176, at: 0.18, duration: 0.24, peak: 0.4 },
  ],
  accepted: [
    { freq: 659, at: 0, duration: 0.11, peak: 0.18 },
    { freq: 880, at: 0.1, duration: 0.11, peak: 0.18 },
    { freq: 1175, at: 0.2, duration: 0.26, peak: 0.18 },
  ],
};

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let gestureBound = false;
let loopTimer: number | null = null;
let loopKind: AlertKind = 'neutral';
let lastSoundedAt = 0;
let desiredKind: AlertKind = 'neutral';
let currentKind: AlertKind = 'neutral';
let pausedForHidden = false;

/** Gap between repeats while stuck in one band. */
const LOOP_MS = 1000;
/**
 * Chatter guard: near the target a jittery scale can flip under/over several
 * times a second. A new band only speaks up once this much time has passed.
 */
const BAND_SWITCH_MIN_MS = 600;

function clearLoopTimer(): void {
  if (loopTimer === null) return;
  if (typeof window !== 'undefined') window.clearTimeout(loopTimer);
  loopTimer = null;
}

/** Stops any repeating alert. Safe to call when nothing is ringing. */
export function stopAlertLoop(): void {
  clearLoopTimer();
  loopKind = 'neutral';
}

function armLoop(kind: AlertKind): void {
  clearLoopTimer();
  loopTimer = window.setTimeout(() => {
    loopTimer = null;
    // A newer band took over while this was pending: let it own the loop.
    if (loopKind !== kind) return;
    playAlert(kind);
    armLoop(kind);
  }, LOOP_MS);
}

/**
 * Drives the ringing from the current verdict. Call on every change:
 * out-of-band verdicts ring until something else replaces them, `accepted`
 * chimes once and stops, `neutral` (no reading) falls silent.
 */
export function setAlertLoop(kind: AlertKind): void {
  desiredKind = kind;
  // Guards the one-shot cues against React re-rendering the same verdict.
  const changed = kind !== currentKind;
  currentKind = kind;

  if (!alertsEnabled() || kind === 'neutral') {
    stopAlertLoop();
    return;
  }

  if (kind === 'accepted') {
    stopAlertLoop();
    // Coming from a wrong band this is the payoff: the ringing stops and the
    // chime confirms it. Re-rendering while already accepted must stay silent.
    if (changed) {
      lastSoundedAt = Date.now();
      playAlert('accepted');
    }
    return;
  }

  if (loopKind === kind) return;
  const switchingBand = loopKind !== 'neutral';
  const now = Date.now();
  stopAlertLoop();
  loopKind = kind;

  if (switchingBand && now - lastSoundedAt < BAND_SWITCH_MIN_MS) {
    // Chatter: adopt the new sound but let the next scheduled tick speak it.
    armLoop(kind);
    return;
  }

  lastSoundedAt = now;
  playAlert(kind);
  armLoop(kind);
}

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ??
    null
  );
}

/** Timers are throttled in a hidden tab; go quiet rather than beep into a void. */
function onVisibilityChange(): void {
  if (typeof document === 'undefined') return;
  if (document.hidden) {
    pausedForHidden = loopKind !== 'neutral';
    stopAlertLoop();
    return;
  }
  if (!pausedForHidden) return;
  pausedForHidden = false;
  if (desiredKind !== 'neutral') setAlertLoop(desiredKind);
}

let pageHooksBound = false;
function bindPageHooks(): void {
  if (pageHooksBound || typeof document === 'undefined') return;
  pageHooksBound = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
}

function ensureContext(): AudioContext | null {
  bindPageHooks();
  if (ctx) return ctx;
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.75;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
    master = null;
  }
  return ctx;
}

/**
 * Browsers start the audio context suspended until the page sees a gesture.
 * Call this from a click/keydown handler to unlock alerts up front.
 */
export function primeAlertAudio(): void {
  const context = ensureContext();
  if (!context) return;
  if (context.state === 'running') return;
  // resume() rejects if the context is closed or interrupted; an unhandled
  // rejection here would surface as an error in the console on every tap.
  void context.resume().catch(() => {
    // stays suspended until the next gesture
  });

  // The first interaction anywhere on the page is enough to unlock playback.
  // Bound once; after that these calls return immediately because the context
  // is already running.
  if (gestureBound) return;
  gestureBound = true;
  for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
    window.addEventListener(type, () => primeAlertAudio(), { passive: true });
  }
}

function scheduleTone(kind: Exclude<AlertKind, 'neutral'>, context: AudioContext, out: GainNode, tone: Tone): void {
  const start = context.currentTime + tone.at;
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = kind === 'overweight' ? 'square' : 'triangle';
  osc.frequency.setValueAtTime(tone.freq, start);
  // A short ramp in and an exponential ramp down; a hard stop would click.
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(tone.peak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.duration);
  osc.connect(gain).connect(out);
  osc.start(start);
  osc.stop(start + tone.duration + 0.03);
}

/** Plays the tone for a weight band. No-op when muted or still locked. */
export function playAlert(kind: AlertKind): void {
  if (kind === 'neutral') return;
  if (!alertsEnabled()) return;
  const context = ensureContext();
  if (!context || !master) return;
  if (context.state !== 'running') {
    primeAlertAudio();
    return;
  }
  for (const tone of SOUNDS[kind]) scheduleTone(kind, context, master, tone);
}
