/**
 * Android hardware back button.
 *
 * Capacitor's BridgeActivity does not handle the back button at all, so the
 * default is used and the activity is finished. On this app that means a single
 * habitual tap closes the terminal mid-pour. The cart is persisted, so the
 * work is recoverable, but the operator is dropped out of a weighing with no
 * prompt at all.
 *
 * While a weighing is genuinely in progress the button asks first. When there
 * is nothing to lose it is left alone, because a back button that interrupts
 * every navigation is worse than none.
 */

import { App as CapApp } from '@capacitor/app';
import { isNativeApp } from '../lib/serverAddress.ts';

/**
 * Ask before leaving, but only when there is unsaved work on the scale.
 * Returns a cleanup function.
 */
export function guardBackButton(hasUnsavedWork: () => boolean): () => void {
  if (!isNativeApp()) return () => {};
  const listener = CapApp.addListener('backButton', () => {
    if (!hasUnsavedWork()) {
      void CapApp.exitApp();
      return;
    }
    const discard = window.confirm(
      'A weighing is still in progress and has not been saved. Leaving now will set the terminal aside — you can pick it up again, but unsaved work is at risk. Leave anyway?',
    );
    if (discard) void CapApp.exitApp();
  });
  // addListener returns a Promise of the handle; the app is long-lived, so the
  // handle is captured for cleanup and the async failure is not left unhandled.
  let cancelled = false;
  let remove: (() => Promise<void>) | null = null;
  void listener
    .then((handle) => {
      if (cancelled) void handle.remove();
      else remove = handle.remove;
    })
    .catch(() => {
      // Plugin unavailable; the default Android behaviour stands.
    });
  return () => {
    cancelled = true;
    if (remove) void remove();
  };
}
