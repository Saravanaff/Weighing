/**
 * Global text-size setting.
 *
 * The stylesheets size every piece of text in `px`, so scaling is done by
 * routing each `font-size` through `--font-scale` rather than by changing the
 * root font size (which `px` ignores) or zooming the page (which would move
 * the layout around and disturb the reading on screen).
 *
 * The chosen step is recorded as a `data-font-scale` attribute on <html>
 * instead of an inline custom property. A stylesheet rule can then override it
 * inside `@media print`, which an inline style would always beat — printed
 * reports have to stay at their normal size whatever the operator has chosen
 * for the screen.
 */

const STORAGE_KEY = 'naveen.fontScale';

export interface FontScaleStep {
  /** Stable id written to the data attribute and used in the CSS. */
  id: string;
  /** Multiplier applied to every font size. */
  scale: number;
  /** Shown next to the buttons so the current size is never a guess. */
  label: string;
}

/** Default sits in the middle so the control can grow and shrink both ways. */
export const FONT_SCALE_STEPS: readonly FontScaleStep[] = [
  { id: 'sm', scale: 0.9, label: 'SMALL' },
  { id: 'md', scale: 1, label: 'DEFAULT' },
  { id: 'lg', scale: 1.15, label: 'LARGE' },
  { id: 'xl', scale: 1.3, label: 'EXTRA LARGE' },
];

const DEFAULT_INDEX = FONT_SCALE_STEPS.findIndex((step) => step.scale === 1);

/** Clamps anything unexpected — a hand-edited or stale stored value included. */
function toIndex(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_INDEX;
  const last = FONT_SCALE_STEPS.length - 1;
  return Math.min(last, Math.max(0, Math.round(n)));
}

function readStoredIndex(): number {
  if (typeof window === 'undefined') return DEFAULT_INDEX;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    // An unset key must fall through to the default: Number(null) is 0, which
    // would otherwise hand every fresh install the smallest text size.
    if (raw == null || raw === '') return DEFAULT_INDEX;
    return toIndex(raw);
  } catch {
    // Private mode / storage disabled: the default size still works.
    return DEFAULT_INDEX;
  }
}

export function currentFontScaleIndex(): number {
  return readStoredIndex();
}

export function fontScaleStep(index: number): FontScaleStep {
  return FONT_SCALE_STEPS[toIndex(index)];
}

/**
 * Writes the attribute onto <html>. Called once before the first render so the
 * app never appears at the wrong size and snaps to the right one.
 */
export function applyFontScale(index: number): FontScaleStep {
  const step = fontScaleStep(index);
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-font-scale', step.id);
  }
  return step;
}

export function setFontScaleIndex(index: number): FontScaleStep {
  const clamped = toIndex(index);
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clamped));
  } catch {
    // The setting simply will not survive a reload; the session still uses it.
  }
  return applyFontScale(clamped);
}

/** Reads the stored choice and applies it. Safe to call before React mounts. */
export function initFontScale(): FontScaleStep {
  return applyFontScale(readStoredIndex());
}
