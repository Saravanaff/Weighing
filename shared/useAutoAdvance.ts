import { useEffect, useRef, useState } from 'react';

/**
 * Moves on by itself once a line reads correct.
 *
 * The operator pouring material cannot be expected to keep a finger on a
 * button as well, so a correct weight advances on its own after a pause long
 * enough to take the finished item off the scale, check the bill still adds
 * up, and pull weight back off if they change their mind.
 *
 * The countdown is returned so the terminal can show it; a silent auto-advance
 * reads as the app having skipped a line.
 */

export const AUTO_ADVANCE_MS = 4000;

/** How often the remaining time is republished for the on-screen countdown. */
const TICK_MS = 200;

export interface AutoAdvanceOptions {
  /** True when the line is correct and may advance: the auto-advance guard. */
  ready: boolean;
  /**
   * Identifies the line being weighed. Any change restarts the countdown, so
   * moving to another line, or re-reading after a correction, always waits the
   * full delay again.
   */
  token: string | number | null;
  onAdvance: () => void;
  delayMs?: number;
}

/**
 * Returns the milliseconds still to wait, or 0 when not counting down.
 */
export function useAutoAdvance({
  ready,
  token,
  onAdvance,
  delayMs = AUTO_ADVANCE_MS,
}: AutoAdvanceOptions): number {
  const [remaining, setRemaining] = useState(0);
  // The callback is read through a ref so that a re-render with a new closure
  // cannot restart the countdown, and so the timer never calls a stale one.
  const advanceRef = useRef(onAdvance);
  useEffect(() => {
    advanceRef.current = onAdvance;
  });

  useEffect(() => {
    if (!ready || token == null) {
      setRemaining(0);
      return;
    }

    let advanceTimer: ReturnType<typeof setTimeout> | null = null;
    let tickTimer: ReturnType<typeof setInterval> | null = null;
    const startedAt = Date.now();
    setRemaining(delayMs);

    advanceTimer = setTimeout(() => {
      advanceTimer = null;
      // Stop the display ticking here rather than waiting for the re-render
      // that follows, so the countdown cannot outlive the line it belonged to.
      if (tickTimer !== null) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      setRemaining(0);
      advanceRef.current();
    }, delayMs);

    tickTimer = setInterval(() => {
      setRemaining(Math.max(0, delayMs - (Date.now() - startedAt)));
    }, TICK_MS);

    return () => {
      if (advanceTimer !== null) clearTimeout(advanceTimer);
      if (tickTimer !== null) clearInterval(tickTimer);
      setRemaining(0);
    };
  }, [ready, token, delayMs]);

  return remaining;
}

/** Seconds left, rounded up for display: 4 during a 4000ms countdown. */
export function secondsLeft(remainingMs: number): number {
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}
