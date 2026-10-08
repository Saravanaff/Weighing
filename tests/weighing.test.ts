/**
 * The weighing verdict and the weight rounding behind it.
 *
 * These are the rules that decide whether a batch of feed is recorded as
 * correct, so they are pinned here rather than left to be re-derived from the
 * screen. Everything in this file is a pure function: no server, no scale, no
 * browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  roundOffWeight,
  roundTargetWeight,
  targetRoundingNote,
} from '../shared/targetWeight.ts';
import { evaluateReading, parseWeight, round3 } from '../src/lib/weights.ts';

test('roundOffWeight floors to the whole kilogram below', () => {
  assert.equal(roundOffWeight(51.0), 51);
  assert.equal(roundOffWeight(51.999), 51);
  assert.equal(roundOffWeight(51.2), 51);
  assert.equal(roundOffWeight(50.4), 50);
  assert.equal(roundOffWeight(50.6), 50);
  assert.equal(roundOffWeight(0.4), 0);
  assert.equal(roundOffWeight(0), 0);
});

test('roundOffWeight rounds a negative reading toward zero, never away', () => {
  // An empty pan can read below zero on a real machine. Math.floor sends -0.5
  // to -1, which would inflate the gap between what the operator poured and
  // what the bill records, and grows it on every line of the batch.
  // -0 normalises to 0 rather than serialising as "-0" on a bill.
  for (const value of [-0.5, -0.4, -0.001]) {
    assert.equal(roundOffWeight(value), 0, `${value} is under a kilo, so it is zero`);
    assert.ok(Object.is(roundOffWeight(value), 0), `${value} must not stay -0`);
  }
  assert.equal(roundOffWeight(-1.2), -1);
  assert.equal(roundOffWeight(-2.5), -2);
  assert.equal(roundOffWeight(-15), -15);
  // Never rounds a negative away from zero: -1.2 must not become -2.
  for (const value of [-0.5, -1.2, -2.5, -9.9, -0.001, -1000.5]) {
    assert.ok(
      roundOffWeight(value) >= value,
      `roundOffWeight(${value}) rounded away from zero to ${roundOffWeight(value)}`,
    );
  }
});

test('roundOffWeight absorbs floating point noise instead of losing a kilo', () => {
  // 0.1 + 0.2 style error must not floor 50.9999999999 down to 50.
  assert.equal(roundOffWeight(50.9999999999), 51);
  assert.equal(roundOffWeight(0.1 + 0.2), 0);
  assert.equal(roundOffWeight(2.0000000000000004), 2);
});

test('roundOffWeight never returns a non-finite value', () => {
  // kg * 1000 overflows to Infinity past ~1.8e305, and floor(Infinity) is
  // Infinity. An Infinity total would make every report sum to Infinity and
  // serialise as null, permanently breaking the dashboard.
  for (const value of [NaN, Infinity, -Infinity, 1e308, 1.8e308, Number.MAX_VALUE]) {
    const result = roundOffWeight(value);
    assert.ok(Number.isFinite(result), `roundOffWeight(${value}) was ${result}`);
    assert.equal(result, 0);
  }
});

test('roundTargetWeight never returns zero and always rounds down', () => {
  assert.equal(roundTargetWeight(0.4), 1, 'a sub-kilo target is lifted to the floor');
  assert.equal(roundTargetWeight(0), 1);
  assert.equal(roundTargetWeight(50.8), 50);
  assert.equal(roundTargetWeight(51.4), 51);
  assert.equal(roundTargetWeight(NaN), 1);
  assert.equal(roundTargetWeight(Infinity), 1);
  assert.ok(Number.isFinite(roundTargetWeight(1e308)));
});

test('targetRoundingNote only speaks up when the figure actually changes', () => {
  assert.equal(targetRoundingNote(51), null);
  assert.match(targetRoundingNote(50.6) as string, /50\.6 will be weighed as 50 kg/);
  assert.equal(targetRoundingNote(0), null, 'nothing to say about an empty box');
  assert.equal(targetRoundingNote(NaN), null);
});

test('parseWeight accepts real input and rejects everything else', () => {
  assert.equal(parseWeight('2.5'), 2.5);
  assert.equal(parseWeight(3), 3);
  assert.equal(parseWeight(' 4.25 '), 4.25);
  assert.equal(parseWeight(''), null);
  assert.equal(parseWeight('   '), null);
  assert.equal(parseWeight(null), null);
  assert.equal(parseWeight(undefined), null);
  assert.equal(parseWeight('abc'), null);
  assert.equal(parseWeight('-1'), null, 'a negative weight is not a weight');
  assert.equal(parseWeight(Infinity), null);
  assert.equal(parseWeight('NaN'), null);
});

test('round3 keeps three decimals and refuses to invent them', () => {
  assert.equal(round3(1.23456), 1.235);
  assert.equal(round3(1.2), 1.2);
  assert.equal(round3(0.0004), 0);
  assert.equal(round3(NaN), NaN, 'round3 is arithmetic, and the verdict guards NaN');
});

test('a 51 kg line accepts the whole kilogram the scale can show', () => {
  for (const reading of [51.0, 51.001, 51.2, 51.5, 51.999]) {
    const verdict = evaluateReading(51, reading);
    assert.equal(verdict.correct, true, `${reading} kg should satisfy a 51 kg line`);
    assert.equal(verdict.type, 'accepted');
    assert.equal(verdict.difference, 0);
  }
});

test('a line is refused below its target and told how much is missing', () => {
  const verdict = evaluateReading(51, 49.2);
  assert.equal(verdict.correct, false);
  assert.equal(verdict.type, 'underweight');
  assert.equal(verdict.difference, -2, '49.2 kg floors to 49, so 2 kg are missing');
  assert.match(verdict.detail, /Add 2\.000 kg/);
});

test('a line is refused above its target and told how much to take off', () => {
  const verdict = evaluateReading(51, 52.0);
  assert.equal(verdict.correct, false);
  assert.equal(verdict.type, 'overweight');
  assert.equal(verdict.difference, 1);
  assert.match(verdict.detail, /Remove 1\.000 kg/);
});

test('with no reading the verdict stays neutral and refuses to accept', () => {
  const verdict = evaluateReading(51, null);
  assert.equal(verdict.type, 'neutral');
  assert.equal(verdict.correct, false);
  assert.equal(verdict.difference, null);
});

test('a non-finite reading can never be accepted, whatever the target', () => {
  // The SSE handler filters these, but a verdict that turns NaN into a pass is
  // one refactor away from being reachable, and a pass here writes a bill.
  for (const bad of [NaN, Infinity, -Infinity]) {
    for (const required of [1, 51, 200]) {
      const verdict = evaluateReading(required, bad);
      assert.equal(
        verdict.correct,
        false,
        `evaluateReading(${required}, ${bad}) must not accept`,
      );
    }
  }
});

test('every accepted reading records the target, so a bill cannot disagree with itself', () => {
  // The client stores roundOffWeight(reading) as the actual weight. If the
  // verdict accepted anything whose floored value differed from the target,
  // the printed bill and the stored line would disagree on every single row.
  for (let target = 1; target <= 200; target++) {
    for (const reading of [target, target + 0.001, target + 0.25, target + 0.999]) {
      const verdict = evaluateReading(target, reading);
      assert.equal(verdict.correct, true, `${reading} should satisfy ${target}`);
      assert.equal(
        roundOffWeight(reading),
        target,
        `an accepted reading of ${reading} for target ${target} would be stored as ${roundOffWeight(reading)}`,
      );
    }
  }
});
