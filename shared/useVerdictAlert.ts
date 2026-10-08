import { useEffect } from 'react';
import { setAlertLoop, stopAlertLoop, type AlertKind } from './alerts.ts';

export interface VerdictAlertOptions {
  enabled?: boolean;
}

/**
 * Rings for as long as the weight sits outside the target band and stops the
 * moment it lands on target, so the operator can fix the weight without
 * watching the screen.
 *
 * No stability gate here on purpose: while material is being poured the scale
 * reading is never stable, and waiting for it to settle would silence the cue
 * exactly when it is needed. `setAlertLoop` damps the under/over chatter that
 * jitter near the target produces.
 */
export function useVerdictAlert(kind: AlertKind, options: VerdictAlertOptions = {}): void {
  const { enabled = true } = options;

  useEffect(() => {
    if (!enabled) {
      stopAlertLoop();
      return;
    }
    setAlertLoop(kind);
  }, [kind, enabled]);

  // Leaving the terminal must silence it: NEXT ITEM and CANCEL both unmount.
  useEffect(() => () => stopAlertLoop(), []);
}
