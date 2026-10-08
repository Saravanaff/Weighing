/**
 * How a target weight is rounded before it is stored.
 *
 * A weighing scale cannot land on a weight it has no step for: a target of
 * 5.005 kg on a scale that reports in 10 g steps is never reached, the reading
 * never matches, and the line sits there forever. Rather than leave the
 * operator stuck, the target is snapped to a weight the scale can actually
 * show.
 *
 * The shop's rule is on the last digit, and it always rounds DOWN:
 *
 *   50.4 kg -> 50 kg
 *   50.6 kg -> 50 kg
 *
 * The rounded figure is what gets stored, so the bill, the formula and the
 * scale all show the same number and there is never a target/actual mismatch
 * to explain afterwards.
 */

/** No target below this: a rounded weight of zero is not a weighing. */
const MIN_TARGET_KG = 1;

/**
 * The shop's rule in one line: a weight is always rounded DOWN to the whole
 * kilogram below it. 50.8 kg becomes 50, 51.4 kg becomes 51.
 *
 * A measured weight is rounded the same way a target is, so 51.2 kg on the
 * scale reads as 51 kg and matches a 51 kg target. A measured weight is never
 * lifted to 1 kg — only a target is, because a 0 kg target cannot be weighed or
 * saved.
 */
export function roundOffWeight(kg: number): number {
  if (!Number.isFinite(kg)) return 0;
  // Snapped to 0.001 kg before dropping the remainder, so a value that is a
  // hair under a kilogram because of floating-point noise is not treated as a
  // whole kilo less. A scale reporting 50.9999999999 means 51.000, and that has
  // to land on 51, not 50.
  //
  // The scaled value is checked as well as the input: kg * 1000 overflows to
  // Infinity for anything past ~1.8e305, and floor(Infinity) is still
  // Infinity. An unsanitised client value that large would store Inf as the
  // bill total, and every report then sums to Inf and serialises it as null,
  // which kills the dashboard permanently from a single row.
  const scaled = Math.round(kg * 1000);
  if (!Number.isFinite(scaled)) return 0;
  // Floor, but toward zero on the way down. A scale can sit below zero with an
  // empty pan, and Math.floor sends -0.5 to -1: the offset would double on
  // every line, growing the gap between what the operator poured and what the
  // bill records. Zero is not a weight and neither is anything under it, so a
  // negative figure rounds to zero rather than away from the operator.
  // + 0 so a value that rounds to negative zero comes back as 0 and cannot
  // serialise as "-0" on a bill or a report.
  const whole = scaled / 1000;
  return (whole < 0 ? Math.ceil(whole) : Math.floor(whole)) + 0;
}

/**
 * Snaps a typed target down to the whole kilogram below it, using the rule above.
 *
 * A target that would round down to zero is lifted to 1 kg instead. That is
 * not the rounding rule being bent — a 0 kg target cannot be weighed or saved
 * — so the smallest usable target is the floor.
 */
export function roundTargetWeight(kg: number): number {
  if (!Number.isFinite(kg)) return MIN_TARGET_KG;
  return Math.max(MIN_TARGET_KG, roundOffWeight(kg));
}

/**
 * What the operator typed against what will be used, for the hint shown next to
 * the input. Returns null when the two agree, so the UI can stay quiet.
 */
export function targetRoundingNote(kg: number): string | null {
  if (!Number.isFinite(kg) || kg <= 0) return null;
  const rounded = roundTargetWeight(kg);
  if (rounded === kg) return null;
  return `${formatTarget(kg)} will be weighed as ${formatTarget(rounded)} kg`;
}

function formatTarget(kg: number): string {
  return Number.isInteger(kg) ? String(kg) : kg.toFixed(1);
}
