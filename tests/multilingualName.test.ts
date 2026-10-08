import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startNameLoop, stopNameLoop, isNameLoopActive } from '../shared/multilingualName.ts';

// The multilingual loop requires a browser environment; we can only test
// that starting/stopping toggles the active state in Node by calling the
// functions and checking the active flag. This is a lightweight guard.

test('multilingual name loop active flag toggles', () => {
  const item = { id: 123, name: 'TestItem', native: { hi: 'हाय', bn: 'হাই', ta: 'ஹாய்' } } as any;
  stopNameLoop();
  assert.equal(isNameLoopActive(), false);
  startNameLoop(
    item as any,
    ['en', 'hi', 'bn', 'ta'],
    {
      speak: (_item: any, _lang: string, onDone: () => void) => onDone(),
      stop: () => {},
    },
  );
  assert.equal(isNameLoopActive(), true);
  stopNameLoop();
  assert.equal(isNameLoopActive(), false);
});
