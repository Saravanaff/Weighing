import { roundOffWeight } from '../../shared/targetWeight.ts';

/** How a live/placed weight compares to the weight the recipe requires. */
export type ReadingVerdictType =
  | 'neutral'
  | 'accepted'
  | 'underweight'
  | 'overweight';

export interface ReadingVerdict {
  type: ReadingVerdictType;
  title: string;
  detail: string;
  /** required vs actual, rounded to 3 decimals; null when there is no reading. */
  difference: number | null;
  correct: boolean;
}

export function fmtWeight(weight: number): string {
  return `${weight.toFixed(3)} kg`;
}

export function fmtWeightNoUnit(weight: number): string {
  return weight.toFixed(3);
}

export function fmtSignedDiff(diff: number): string {
  const sign = diff > 0 ? '+' : '';
  return `${sign}${diff.toFixed(3)} kg`;
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function localIsoNow(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  return String(iso).replace('T', ' ');
}

/** Parses a weight typed by hand; rejects blanks, junk and negatives. */
export function parseWeight(raw: unknown): number | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (text === '') return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * Compares the current weight against the required weight and describes the
 * gap. `current === null` means nothing has been weighed yet.
 *
 * The reading is rounded down to whole kilograms the same way the target is, so
 * 51.2 kg on the scale matches a 51 kg target rather than sitting 0.2 kg short
 * of it forever — which, with the NEXT button gone, would never move on. A 51 kg
 * target is therefore met by any reading from 51.000 up to 51.999.
 */
export function evaluateReading(
  required: number,
  current: number | null,
): ReadingVerdict {
  if (current == null) {
    return {
      type: 'neutral',
      title: 'AWAITING INPUT',
      detail: 'Enter the current weight',
      difference: null,
      correct: false,
    };
  }
  const difference = round3(roundOffWeight(current) - required);
  if (difference === 0) {
    return {
      type: 'accepted',
      title: 'WEIGHT ACCEPTED',
      detail: 'STABLE',
      difference,
      correct: true,
    };
  }
  if (difference < 0) {
    return {
      type: 'underweight',
      title: 'UNDERWEIGHT',
      detail: `Add ${fmtWeight(round3(-difference))}`,
      difference,
      correct: false,
    };
  }
  return {
    type: 'overweight',
    title: 'OVERWEIGHT',
    detail: `Remove ${fmtWeight(difference)}`,
    difference,
    correct: false,
  };
}
