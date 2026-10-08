/**
 * Turns the scale's running total into the weight of the item being weighed.
 *
 * The scale is never re-zeroed between lines, and nothing is taken off the pan
 * at the end of a line, so the reading only ever grows. Line 1 asks for 100 kg:
 * the reading climbs to 100 and the line is accepted. Line 2 asks for 50 kg, so
 * the reading climbs to 150 — that 150 is everything sitting on the pan, not the
 * weight of the item just added. Judged against the target directly, line 2
 * would read as 50 kg overweight and every line after the first would be worse
 * still, because the error is the whole weight of the batch before it.
 *
 * So the reading the scale showed when the line started is held as a zero point
 * and subtracted from every reading on that line. The net weight is what gets
 * compared to the target and what gets recorded on the bill, while the scale
 * itself is left running, which is what a real pan does.
 *
 * The zero point is captured from whatever the scale reads when weighing starts,
 * so a pan that is not perfectly empty to begin with is accounted for too, and
 * it is then carried forward to the reading each line was accepted at.
 *
 * The zero point keeps its sign. A scale whose empty pan reads below zero is a
 * normal machine, not a broken one, and that offset has to stay in the zero
 * point: fold it away and every line records less than is really on the pan, so
 * the operator pours until the display reads right, the bill records the target,
 * and the shop has quietly given away the difference on every single line.
 *
 * A reading that falls below the zero point means material came off the pan.
 * The difference is clamped at zero and the terminal says so, rather than the
 * zero point quietly following the reading down: one outlying frame would then
 * shift every remaining line by that much and accept weight that was never on
 * the scale.
 *
 * Shared by the admin and staff apps so the rule cannot drift between them.
 */

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export class TareBaseline {
  /** The accumulated reading treated as zero for the line being weighed. */
  private base = 0;

  /**
   * False while the scale has not yet said what an empty pan reads. The zero
   * point is not really 0 until something has been read, because it may be a
   * small negative number on a perfectly healthy scale.
   */
  private established = false;

  /**
   * How far below the zero point a reading has to fall before it counts as
   * material coming off.
   *
   * Generous on purpose. A machine that sits below zero drifts most where it
   * lives, and a few hundred grams of that drift is not the operator knocking a
   * bucket off the pan: warning about it would stop them on every single line.
   *
   * This only decides whether to warn. net() clamps at zero either way, so a
   * reading inside this band still cannot record weight that is not there.
   */
  private readonly dropTolerance: number;

  constructor(dropTolerance = 0.5) {
    this.dropTolerance = dropTolerance;
  }

  /**
   * Treat whatever the scale is reading right now as zero. Used when weighing
   * starts, so the first line is measured against the pan as it was found, and
   * by the ZERO HERE button when material has been taken off mid-session.
   *
   * The reading is kept exactly as it is, negative included. A scale whose empty
   * pan sits below zero is a normal machine, not a broken one, and that offset
   * belongs in the zero point: dropping it would make every line record less
   * material than is really on the pan.
   *
   * With nothing being read yet the zero point is left unestablished rather than
   * assumed to be 0, because on a scale that reads below zero, assuming 0 is
   * assuming the batch does not exist. adoptEmptyPan() takes the real figure as
   * soon as the scale speaks.
   */
  zeroAt(current: number | null): void {
    if (current == null) {
      this.established = false;
      return;
    }
    this.base = round3(current);
    this.established = true;
  }

  /**
   * Take the zero point from a reading that says the pan is empty.
   *
   * Used when weighing began before the scale was talking. Only a reading at or
   * below zero is taken, because that is the only reading that proves the pan
   * is empty: had the operator already poured, the reading would be positive
   * and zeroing to it would throw away real material.
   *
   * @returns true when this reading became the zero point.
   */
  adoptEmptyPan(current: number | null): boolean {
    if (this.established || current == null || current > 0) return false;
    this.zeroAt(current);
    return true;
  }

  /**
   * True once a reading has fixed the zero point. Until then it is a guess, and
   * the terminal says so rather than presenting a bare 0.000 kg as fact.
   */
  isEstablished(): boolean {
    return this.established;
  }

  /**
   * The weight sitting on top of the zero point, which is the item being
   * weighed. Never negative, and null when the scale is reporting nothing.
   */
  net(current: number | null): number | null {
    if (current == null) return null;
    return Math.max(0, round3(round3(current) - this.base));
  }

  /**
   * True when the reading has dropped well below the zero point, i.e. material
   * came off the pan. The line cannot be completed until the zero is re-taken.
   */
  underBase(current: number | null): boolean {
    if (current == null || !this.established) return false;
    return round3(current) - this.base < -this.dropTolerance;
  }

  /**
   * The accumulated reading a line was accepted at becomes the zero point for
   * the next one, because the finished item is still on the pan.
   */
  carry(accumulated: number | null): void {
    if (accumulated == null) return;
    this.base = round3(accumulated);
    this.established = true;
  }

  /** Forget the zero point, e.g. when weighing is cancelled or starts over. */
  reset(): void {
    this.base = 0;
    this.established = false;
  }

  /** The zero point itself, so the terminal can show what the pan is carrying. */
  baseValue(): number {
    return this.base;
  }
}