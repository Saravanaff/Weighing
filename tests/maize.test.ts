/**
 * The maize test that drives the PLC output.
 *
 * The output is wired to the maize line only, and the item name is typed by
 * hand when the item (or the formula that uses it) is created, so the cases
 * here are the exact ways the same word arrives: capitalised, shouted, spaced,
 * or pasted with a full-width or zero-width character. A false positive moves a
 * machine that should be still; a false negative stops a batch, so both
 * directions are pinned.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isMaizeItem, isMaizeName, normalizeItemKey } from '../shared/maize.ts';

test('every casing and spacing of "maize" is maize', () => {
  const names = ['Maize', 'MAIZE', 'maize', 'mAiZe', '  Maize  ', 'Maize\t', '\uFF2D\uFF21\uFF29\uFF3A\uFF25', 'Maize\u200b'];
  for (const name of names) {
    assert.equal(isMaizeName(name), true, JSON.stringify(name));
  }
});

test('neither blank nor a different ingredient is maize', () => {
  const names = ['', '   ', 'Wheat', 'Maiz', 'Maizes', 'Maize Bran', 'Maize Gluten', 'Yellow Maize', 'corn'];
  for (const name of names) {
    assert.equal(isMaizeName(name), false, JSON.stringify(name));
  }
  assert.equal(isMaizeName(null), false);
  assert.equal(isMaizeName(undefined), false);
});

test('a cart line or item is maize by name', () => {
  assert.equal(isMaizeItem({ name: 'MAIZE', slug: '' }), true);
  assert.equal(isMaizeItem({ name: 'Maize', slug: 'maize' }), true);
  assert.equal(isMaizeItem({ name: 'Wheat Bran', slug: 'wheat-bran' }), false);
  assert.equal(isMaizeItem(null), false);
});

test('the slug is a fallback for a name stored with punctuation', () => {
  assert.equal(isMaizeItem({ name: 'Maize.', slug: 'maize' }), true);
  assert.equal(isMaizeItem({ name: 'Maize Bran', slug: 'maize-bran' }), false);
});

test('normalizeItemKey folds width, case and whitespace', () => {
  assert.equal(normalizeItemKey('  \uFF2D\uFF21\uFF29\uFF3A\uFF25  '), 'maize');
  assert.equal(normalizeItemKey('Maize\u200b Bran'), 'maize bran');
});
