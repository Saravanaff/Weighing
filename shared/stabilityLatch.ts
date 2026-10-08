/**
 * Remembers that the scale has settled at the weight that is currently being
 * accepted.
 *
 * A live scale has to be settled before a line counts, otherwise a reading
 * that merely swept past the target mid-placement gets accepted. Requiring the
 * scale's own stable flag to stay true for the whole four second auto-advance
 * countdown is stricter than that, though: the flag flickers on ordinary scales
 * as the load settles, and every flicker restarted the countdown, so a line
 * that was correct and had already been seen to settle could sit there showing
 * TARGET REACHED without ever moving on.
 *
 * So the scale only has to report stable once, at the weight being accepted.
 * After that the settled reading is remembered and a momentary flicker no
 * longer holds the line up. A material change in the reading re-arms the
 * requirement, because a different weight is a different decision.
 *
 * Shared by the admin and staff apps so the rule cannot drift between them.
 */

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export class StabilityLatch {
  /** Weight the scale was last seen to settle at, or null when re-armed. */
  private settledAt: number | null = null;

  /** Tolerance for "the reading moved", matching the re-zero latch. */
  private readonly epsilon: number;

  constructor(epsilon = 0.05) {
    this.epsilon = epsilon;
  }

  /**
   * Feed the current reading and stable flag. Re-arms whenever the reading is
   * missing or no longer correct, and remembers a stable correct reading so a
   * later flicker at the same weight keeps the line moving.
   */
  observe(weight: number | null, stable: boolean, correct: boolean): void {
    if (weight == null || !correct) {
      this.settledAt = null;
      return;
    }
    const current = round3(weight);
    // Already settled at this weight: a flicker must not clear it, and a
    // stable reading simply refreshes the remembered value.
    if (this.settledAt != null && Math.abs(current - this.settledAt) < this.epsilon) {
      if (stable) this.settledAt = current;
      return;
    }
    // A different weight, so stability has to be seen again at that weight.
    this.settledAt = stable ? current : null;
  }

  /** True once the scale has been seen to settle at this same weight. */
  hasSettled(weight: number | null): boolean {
    if (weight == null || this.settledAt == null) return false;
    return Math.abs(round3(weight) - this.settledAt) < this.epsilon;
  }

  /** Forget the settled reading, e.g. when a line changes or weighing restarts. */
  reset(): void {
    this.settledAt = null;
  }
}
