import { useEffect, useRef, useState } from 'react';
import { fmtWeightNoUnit } from '../lib/weights.ts';

const TWEEN_MS = 120;
const SETTLE_MS = 420;

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export interface ScaleProps {
  /** The weight to display, or null/undefined to fall back to zero. */
  value: number | null | undefined;
  /**
   * Device-reported stability. While this is null the dial falls back to its
   * own settle guess, which is the best it can do before the machine has said
   * anything.
   */
  liveStable?: boolean | null;
}

/**
 * The terminal's big readout: the LCD strip alone, with no drawn scale around
 * it. The lamps, pan, housing and feet used to be drawn here too, but on the
 * shop floor the only thing that matters is the number, so this is just the
 * display and the CSS gives it the whole panel to fill.
 */
export function Scale({
  value,
  liveStable = null,
}: ScaleProps) {
  const hasReading = value != null && Number.isFinite(value);
  const target = hasReading ? (value as number) : 0;
  const [displayed, setDisplayed] = useState(0);
  const [, setSettling] = useState(false);
  const [settled, setSettled] = useState(false);
  const displayedRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The device decides when a weighing has stopped moving; the animation only
  // guesses that until the machine reports its own flag. With no live reading
  // there is nothing that has settled at all -- tweening to zero would light
  // the digits as a settled weight on a scale that is merely disconnected,
  // which reads as "the pan is empty" when the truth is "nothing is being
  // reported".
  const stable = !hasReading
    ? false
    : liveStable !== null && liveStable !== undefined
      ? Boolean(liveStable)
      : settled;

  useEffect(() => {
    displayedRef.current = displayed;
  }, [displayed]);

  useEffect(() => {
    const to = target;
    const from = displayedRef.current;
    const duration = TWEEN_MS;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    setSettling(false);
    setSettled(false);

    let start: number | null = null;
    const step = (time: number) => {
      if (start === null) start = time;
      const progress = Math.min((time - start) / duration, 1);
      const next = from + (to - from) * easeOut(progress);
      displayedRef.current = next;
      setDisplayed(next);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        setSettling(true);
        settleTimerRef.current = setTimeout(() => {
          setSettling(false);
          setSettled(true);
        }, SETTLE_MS);
      }
    };

    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    };
  }, [target]);

  return (
    <div className="scale">
      <div className="scale-lcd">
        <span className="scale-reading" data-status={stable ? 'on' : 'transit'}>
          {hasReading ? fmtWeightNoUnit(displayed) : '—.———'}
        </span>
        <span className="scale-lcd-unit">kg</span>
      </div>
    </div>
  );
}
