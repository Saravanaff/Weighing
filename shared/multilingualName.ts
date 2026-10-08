/**
 * Repeats an item's name in every language until the weight reaches target.
 *
 * Underweight is the band where the operator is still adding material and
 * cannot look at the screen, so the name is spoken over and over rather than
 * once. Each language is spoken in turn — the operator's own choice first, then
 * the rest — and the whole set repeats until something tells the loop to stop.
 *
 * The module holds no audio of its own: `speak` and `stop` are injected so the
 * shared code stays free of app-level imports, exactly as `alerts.ts` is.
 */

export type NameLoopLang = string;

/** Mirrors LangCode so this module stays free of app-level imports. */
export type SpeakName = (
  item: unknown,
  lang: NameLoopLang,
  onDone: () => void,
) => void;

export interface NameLoopOptions {
  speak: SpeakName;
  stop: () => void;
}

/**
 * Pause between languages. Long enough that the next name does not run into
 * the last one, short enough that a four-language cycle still feels responsive.
 */
const LANG_GAP_MS = 320;

let activeItem: unknown = null;
let activeLangs: NameLoopLang[] = [];
let index = 0;
let options: NameLoopOptions | null = null;
let gapTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Bumped on every start and stop. A clip that finishes after the loop moved on
 * compares against this and does nothing, which is what stops a cancelled or
 * superseded clip from advancing a cycle that no longer exists.
 */
let generation = 0;

function clearGapTimer(): void {
  if (gapTimer === null) return;
  clearTimeout(gapTimer);
  gapTimer = null;
}

/** Puts the chosen language first so the loop opens in the operator's own. */
export function orderLangs(
  selected: NameLoopLang,
  all: readonly NameLoopLang[],
): NameLoopLang[] {
  const rest = all.filter((lang) => lang !== selected);
  return [selected, ...rest];
}

function speakCurrent(): void {
  const lang = activeLangs[index];
  const item = activeItem;
  const opts = options;
  if (!opts || lang == null || item == null) return;
  const mine = generation;
  try {
    opts.speak(item, lang, () => {
      if (mine !== generation) return;
      index = (index + 1) % activeLangs.length;
      clearGapTimer();
      gapTimer = setTimeout(() => {
        gapTimer = null;
        speakCurrent();
      }, LANG_GAP_MS);
    });
  } catch {
    // A throwing speak() must not leave a timer armed and the loop stuck.
  }
}

/**
 * Starts (or restarts) the cycle. Restarting the same item in the same
 * language order is a no-op, so a re-render cannot cut off the clip that is
 * currently being spoken.
 */
export function startNameLoop(
  item: unknown,
  langs: readonly NameLoopLang[],
  opts: NameLoopOptions,
): void {
  const sameItem = item === activeItem && options !== null;
  const sameOrder =
    sameItem &&
    langs.length === activeLangs.length &&
    langs.every((lang, i) => lang === activeLangs[i]);
  if (sameOrder) return;

  stopNameLoop();
  if (item == null || langs.length === 0) return;

  activeItem = item;
  activeLangs = [...langs];
  index = 0;
  options = opts;
  generation += 1;
  speakCurrent();
}

/** Silences the cycle. Safe to call when nothing is repeating. */
export function stopNameLoop(): void {
  generation += 1;
  clearGapTimer();
  activeItem = null;
  activeLangs = [];
  index = 0;
  options?.stop();
  options = null;
}

/** True while a cycle is running; used by tests and diagnostics. */
export function isNameLoopActive(): boolean {
  return options !== null;
}
