/**
 * The two guards that stand between a raw scale reading and a recorded bill.
 *
 * The tare baseline turns the scale's running total into the weight of the item
 * actually being weighed, because the pan is never re-zeroed and nothing is
 * taken off it between lines. The stability latch remembers that the scale was
 * seen to settle at the weight now being accepted. Between them they are the
 * only things standing between a leftover reading and a recorded kilogram, so
 * they are pinned here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TareBaseline } from '../shared/tareBaseline.ts';
import { StabilityLatch } from '../shared/stabilityLatch.ts';
import { roundOffWeight } from '../shared/targetWeight.ts';
import { evaluateReading } from '../src/lib/weights.ts';

test('a scale reading below zero keeps that offset in the zero point', () => {
  // The real machine: an empty pan sits at -0.500 kg. Folding the sign away
  // would put 50 kg of feed on the pan at a net of 49.5, the operator would
  // keep pouring until the display read 50, and every line would hand over
  // half a kilo the shop never got paid for.
  const tare = new TareBaseline();
  tare.zeroAt(-0.5);
  assert.equal(tare.baseValue(), -0.5);
  assert.equal(tare.net(-0.5), 0, 'an empty pan weighs nothing');
  assert.equal(tare.net(49.5), 50, '50 kg of feed on a pan 0.5 below zero is 50 kg');
  assert.equal(evaluateReading(50, tare.net(49.5)).correct, true);
});

test('a whole batch on a scale that starts negative records every line in full', () => {
  const tare = new TareBaseline();
  tare.zeroAt(-0.75);
  const targets = [100, 50, 200];
  let accumulated = -0.75;
  const recorded: number[] = [];
  for (const target of targets) {
    // The operator pours until the terminal reads the target, so the raw reading
    // sits a fixed 0.75 below the material actually on the pan, every line.
    accumulated += target;
    const net = tare.net(accumulated) as number;
    assert.equal(net, target, 'the offset must not creep into the recorded weight');
    assert.equal(roundOffWeight(net), target);
    assert.equal(evaluateReading(target, net).correct, true);
    recorded.push(net);
    tare.carry(accumulated);
  }
  assert.deepEqual(recorded, targets, 'each line records its own weight in full');
  assert.equal(tare.baseValue(), 349.25, 'the pan carries the whole batch less the offset');
});

test('an offset scale carries the offset forward line by line', () => {
  const tare = new TareBaseline();
  tare.zeroAt(-1.25);
  tare.carry(48.75); // 50 kg accepted
  assert.equal(tare.net(48.75), 0, 'the accepted weight is now the zero');
  assert.equal(tare.net(73.75), 25, '25 kg on top still reads 25, not 23.75');
});

test('a negative zero point is not mistaken for material coming off', () => {
  // The machine lives below zero and drifts where it lives. Reporting LOAD
  // REMOVED for that would stop the operator on every single line.
  const tare = new TareBaseline();
  tare.zeroAt(-0.6);
  assert.equal(tare.underBase(-0.6), false);
  assert.equal(tare.underBase(-0.75), false, '150 g of drift is not a lost bucket');
  assert.equal(tare.underBase(-1.2), true, '600 g below the zero point is real');
});

test('the zero point is not claimed until the scale has said something', () => {
  // START WEIGHING can run before the serial port finishes opening. Assuming an
  // empty pan reads 0 would quietly assume the batch does not exist on a
  // machine that never reads 0.
  const tare = new TareBaseline();
  tare.zeroAt(null);
  assert.equal(tare.isEstablished(), false);
  assert.equal(tare.baseValue(), 0, 'still a placeholder, not a measurement');
});

test('the first empty-pan reading becomes the zero point', () => {
  const tare = new TareBaseline();
  tare.zeroAt(null);
  assert.equal(tare.adoptEmptyPan(-0.5), true, 'a negative first reading is adopted');
  assert.equal(tare.isEstablished(), true);
  assert.equal(tare.baseValue(), -0.5);
  assert.equal(tare.net(49.5), 50);
});

test('a first reading that is already positive is never zeroed to', () => {
  // The port opened late and the operator had already poured. Zeroing to that
  // reading would throw away the material already weighed.
  const tare = new TareBaseline();
  tare.zeroAt(null);
  assert.equal(tare.adoptEmptyPan(30), false);
  assert.equal(tare.isEstablished(), false);
  assert.equal(tare.net(30), 30, 'the 30 kg already poured is still counted');
});

test('an established zero point is not overwritten by a later empty pan', () => {
  const tare = new TareBaseline();
  tare.zeroAt(-0.5);
  assert.equal(tare.adoptEmptyPan(-0.9), false, 'the offset was taken once, at the start');
  assert.equal(tare.baseValue(), -0.5);
});

test('adopting an empty pan needs a reading to adopt', () => {
  const tare = new TareBaseline();
  tare.zeroAt(null);
  assert.equal(tare.adoptEmptyPan(null), false);
  assert.equal(tare.isEstablished(), false);
});

test('an unestablished zero point never claims a load came off', () => {
  const tare = new TareBaseline();
  tare.zeroAt(null);
  assert.equal(tare.underBase(-5), false, 'there is no zero to have fallen below');
});

test('the pan as found is the zero point for the first line', () => {
  // A scale that never sits exactly at 0.000 kg must not turn line 1 into a
  // permanent overweight reading.
  const tare = new TareBaseline();
  tare.zeroAt(0.3);
  assert.equal(tare.net(0.3), 0);
  assert.equal(tare.net(51.3), 51);
  assert.equal(tare.net(51.9), 51.6);
});

test('the first line is measured raw when the pan starts empty', () => {
  const tare = new TareBaseline();
  tare.zeroAt(0);
  assert.equal(tare.net(51.2), 51.2);
  assert.equal(tare.baseValue(), 0);
});

test('a second line is measured as the difference, not the running total', () => {
  // The whole point. 100 kg is on the pan and the target is 50 kg, so the
  // reading climbs to 150 — that 150 must not be judged against a 50 kg target.
  const tare = new TareBaseline();
  tare.zeroAt(0);
  tare.carry(100);
  assert.equal(tare.net(100), 0, 'the accepted weight cannot satisfy the next line');
  assert.equal(tare.net(140), 40);
  assert.equal(tare.net(149.5), 49.5);
  assert.equal(tare.net(150.4), 50.4);
});

test('the zero point follows the reading each line was accepted at', () => {
  // A real session: 100, then 50, then 200, with nothing ever taken off.
  const tare = new TareBaseline();
  tare.zeroAt(0);
  const weights = [100, 50, 200];
  const recorded: number[] = [];
  let accumulated = 0;
  for (const target of weights) {
    accumulated += target;
    assert.equal(evaluateReading(target, tare.net(accumulated)).correct, true);
    recorded.push(tare.net(accumulated) as number);
    tare.carry(accumulated);
  }
  assert.deepEqual(recorded, weights, 'each line records its own weight, not the total');
  assert.equal(tare.baseValue(), 350, 'the pan ends up carrying the whole batch');
});

test('a repeated target is weighable again even with the pan left loaded', () => {
  // Formulas really do repeat targets back to back (100, 50, 100, 100, 200).
  // Refusing the second 100 kg because the pan already reads 100 was the bug the
  // baseline replaces.
  const tare = new TareBaseline();
  tare.zeroAt(0);
  tare.carry(100);
  assert.equal(tare.net(100), 0, 'nothing added yet');
  assert.equal(evaluateReading(100, tare.net(199.9)).correct, false, 'still 0.1 kg short');
  assert.equal(tare.net(200.4), 100.4);
  assert.equal(evaluateReading(100, tare.net(200.4)).correct, true);
});

test('the difference is never negative, and a dropped load is flagged', () => {
  const tare = new TareBaseline();
  tare.zeroAt(0);
  tare.carry(100);
  assert.equal(tare.underBase(100), false, 'nothing has come off yet');
  assert.equal(tare.underBase(30), true, '70 kg came off the pan');
  assert.equal(tare.net(30), 0, 'clamped, not a negative weight for the item');
  // A negative net could never reach a 1 kg-or-more target anyway, so the line
  // is stuck until the operator deals with the pan rather than silently
  // accepting a reading that lost material.
  assert.equal(evaluateReading(50, tare.net(30)).correct, false);
});

test('a reading at the zero point is not treated as a removal', () => {
  // The drop tolerance is generous, because the flag only guards the operator
  // from losing material: net() clamps at zero regardless, so a reading inside
  // the band still cannot record weight that is not on the pan.
  const tare = new TareBaseline();
  tare.zeroAt(0);
  tare.carry(51.2);
  assert.equal(tare.underBase(51.2), false);
  assert.equal(tare.underBase(51.18), false, 'a couple of grams is not a lost bucket');
  assert.equal(tare.underBase(51.0), false, '200 g of drift is still the same load');
  assert.equal(tare.underBase(50.4), true, '800 g below the zero point is real');
  assert.equal(tare.net(51.0), 0, 'and the net weight is clamped, never negative');
});

test('an outlying low frame never moves the zero point', () => {
  // Following a bad frame down would shift every remaining line by that much
  // and accept weight that was never weighed.
  const tare = new TareBaseline();
  tare.zeroAt(0);
  tare.carry(100);
  tare.net(12.5);
  assert.equal(tare.baseValue(), 100, 'reading a bad frame does not re-zero the scale');
  assert.equal(tare.net(150), 50, 'the line is still measured against the real zero');
});

test('a null reading yields a null weight rather than a zero', () => {
  // Zero would read as 0 kg on the terminal and look like a real measurement.
  const tare = new TareBaseline();
  tare.zeroAt(null);
  assert.equal(tare.net(null), null);
  assert.equal(tare.underBase(null), false);
  tare.carry(100);
  assert.equal(tare.net(null), null);
  assert.equal(tare.baseValue(), 100, 'a dropped frame does not clear the zero point');
});

test('carrying nothing leaves the zero point alone', () => {
  const tare = new TareBaseline();
  tare.zeroAt(0);
  tare.carry(100);
  tare.carry(null);
  assert.equal(tare.baseValue(), 100);
});

test('reset forgets the zero point', () => {
  const tare = new TareBaseline();
  tare.zeroAt(0);
  tare.carry(100);
  tare.reset();
  assert.equal(tare.baseValue(), 0);
  assert.equal(tare.net(100), 100);
});

test('the baseline is not fooled by floating point noise', () => {
  const tare = new TareBaseline();
  tare.zeroAt(0);
  tare.carry(51.2);
  assert.equal(tare.net(51.2 + 1e-12), 0, 'a hair of noise is the same weight');
  assert.equal(tare.net(101.2), 50);
});

test('a deep session of repeat targets records every line correctly', () => {
  // The invariant the whole feature exists to protect: on a pan that is never
  // cleared, every accepted line still records its own weight on the bill.
  const tare = new TareBaseline();
  tare.zeroAt(0);
  const targets = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 200];
  let accumulated = 0;
  for (const target of targets) {
    for (const offset of [0, 0.4, 0.999]) {
      const reading = tare.net(accumulated + target + offset);
      assert.equal(
        evaluateReading(target, reading).correct,
        true,
        `${target} kg at +${offset} must be accepted`,
      );
    }
    assert.equal(evaluateReading(target, tare.net(accumulated + target - 1)).correct, false);
    accumulated += target;
    tare.carry(accumulated);
  }
  assert.equal(tare.baseValue(), 575);
});

test('stability latch requires the scale to have settled at the weight', () => {
  const latch = new StabilityLatch();
  assert.equal(latch.hasSettled(51.2), false, 'nothing observed yet');

  latch.observe(51.2, true, true);
  assert.equal(latch.hasSettled(51.2), true, 'a stable correct reading settles it');
});

test('stability latch ignores a correct reading the scale called unstable', () => {
  const latch = new StabilityLatch();
  latch.observe(51.2, false, true);
  assert.equal(
    latch.hasSettled(51.2),
    false,
    'a weight that swept past mid-placement must not count as settled',
  );
});

test('stability latch survives a flicker at the same weight', () => {
  // The whole reason this latch exists: requiring the flag to hold for the
  // whole 4s countdown meant ordinary flicker restarted the countdown and
  // left a correct line stuck on TARGET REACHED.
  const latch = new StabilityLatch();
  latch.observe(51.2, true, true);
  latch.observe(51.2, false, true); // flicker
  assert.equal(latch.hasSettled(51.2), true, 'a momentary flicker must not un-settle');
});

test('stability latch re-arms when the weight changes', () => {
  const latch = new StabilityLatch();
  latch.observe(51.2, true, true);
  latch.observe(48.0, true, true); // a different, still-correct-for-something weight
  assert.equal(
    latch.hasSettled(51.2),
    false,
    'settling at one weight says nothing about a different one',
  );
});

test('stability latch re-arms when the reading goes wrong or missing', () => {
  const latch = new StabilityLatch();
  latch.observe(51.2, true, true);
  latch.observe(51.2, true, false); // no longer correct
  assert.equal(latch.hasSettled(51.2), false);

  latch.observe(51.2, true, true);
  latch.observe(null, true, true); // nothing being read
  assert.equal(latch.hasSettled(51.2), false);
  assert.equal(latch.hasSettled(null), false);
});

test('stability latch reset forgets the settled reading', () => {
  const latch = new StabilityLatch();
  latch.observe(51.2, true, true);
  latch.reset();
  assert.equal(latch.hasSettled(51.2), false);
});

test('stability latch is not fooled by floating point noise', () => {
  const latch = new StabilityLatch();
  latch.observe(51.2, true, true);
  assert.equal(latch.hasSettled(51.2 + 1e-12), true, 'a hair of noise is the same weight');
});