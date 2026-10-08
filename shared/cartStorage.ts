/**
 * Weighing cart persistence, shared by the admin and staff terminals.
 *
 * A weighing is physical material being poured onto a scale. If the phone
 * reloads, the app is killed, or the screen locks halfway through a formula,
 * the measured weights only existed in React state and were gone for good, so
 * the operator had to re-pour and re-weigh material that had already been
 * recorded. So both apps keep the cart in localStorage.
 *
 * localStorage rather than sessionStorage, deliberately: sessionStorage is tied
 * to a single browsing context, and the Android WebView's context is destroyed
 * when the activity is killed by the OS or the app is swiped away. That is
 * precisely the case this is here for, and sessionStorage would not have
 * covered it. The cost is that localStorage outlives the app, so every record
 * carries a timestamp and anything older than MAX_CART_AGE_MS is dropped --
 * a cart from yesterday morning is never resumed into today's work.
 *
 * The completed bill payload is stored alongside the cart, because the save
 * that follows the last line is exactly the step most likely to fail on a
 * flaky shop Wi-Fi, and a failed save is the one thing that must not be lost.
 */

import { roundTargetWeight } from './targetWeight.ts';

/** Structural copy of a cart line. Both apps' CartItem is assignable to this. */
export interface StorableLine {
  uid: string;
  id: number | null;
  slug: string;
  name: string;
  imagePath?: string | null;
  required: number;
  status: 'pending' | 'active' | 'completed';
  actual?: number | null;
  formulaName?: string | null;
  formulaId?: number | null;
}

export interface StorableCart {
  formulaId: number | null;
  formulaName: string | null;
  lines: StorableLine[];
  /** When this was written, used to drop a cart left over from a previous day. */
  savedAt: number;
}

const CART_KEY = 'koushi.cart';
const PAYLOAD_KEY = 'koushi.cart.pending-bill';

/**
 * A shift is long but not endless. Anything older is a different day's work and
 * resuming it into today's cart would mix two batches into one bill.
 */
const MAX_CART_AGE_MS = 12 * 60 * 60 * 1000;

const storage = (): Storage | null => {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    // Private mode / storage disabled. Weighing still works, it just will not
    // survive a reload.
    return null;
  }
};

export function saveCart(cart: StorableLine[], formulaId: number | null): void {
  const store = storage();
  if (!store) return;
  try {
    const first = cart.find((line) => line.formulaId != null);
    const payload: StorableCart = {
      formulaId: first?.formulaId ?? formulaId,
      formulaName: first?.formulaName ?? null,
      savedAt: Date.now(),
      lines: cart.map((line) => ({
        uid: line.uid,
        id: line.id,
        slug: line.slug,
        name: line.name,
        imagePath: line.imagePath ?? null,
        required: roundTargetWeight(line.required),
        status: line.status,
        actual: line.actual ?? null,
        formulaName: line.formulaName ?? null,
        formulaId: line.formulaId ?? null,
      })),
    };
    store.setItem(CART_KEY, JSON.stringify(payload));
  } catch {
    // Nothing to do: the weighing in progress is unaffected.
  }
}

/**
 * Read the stored cart back. Anything in an unexpected shape is discarded
 * rather than half-restored, because a cart that silently lost a line would
 * bill the operator for less than they actually weighed.
 */
export function loadCart(): StorableCart | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(CART_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StorableCart;
    if (!parsed || !Array.isArray(parsed.lines) || parsed.lines.length === 0) return null;
    // A record written before this field existed, or one from a previous day.
    // Either way it is not a weighing in progress, so drop it rather than
    // guessing.
    if (!Number.isFinite(parsed.savedAt)) return null;
    if (Date.now() - parsed.savedAt > MAX_CART_AGE_MS) {
      clearStoredCart();
      return null;
    }
    const bad = parsed.lines.some(
      (line) =>
        !line ||
        typeof line.uid !== 'string' ||
        !line.name ||
        !Number.isFinite(line.required) ||
        (line.status !== 'pending' && line.status !== 'active' && line.status !== 'completed'),
    );
    if (bad) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearStoredCart(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(CART_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** The bill that still has to reach the server, so a failed save can be retried. */
export function savePendingBill(payload: unknown): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(PAYLOAD_KEY, JSON.stringify({ ...(payload as object), savedAt: Date.now() }));
  } catch {
    // Nothing to do.
  }
}

export function loadPendingBill<T>(): T | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(PAYLOAD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: number } & T;
    // Validated rather than cast blindly: this drives the retry screen, and a
    // half-written or hand-edited record must not reach the save call as if it
    // were a bill. Anything unexpected is discarded, not repaired.
    const lines = (parsed as { lines?: unknown }).lines;
    if (!Array.isArray(lines) || lines.length === 0) {
      clearPendingBill();
      return null;
    }
    // The reference is what makes a retry safe: it is how the server knows a
    // repeated save is the same bill. A record without one would be re-posted
    // as a new bill, so it is not offered for retry at all.
    const ref = (parsed as { ref?: unknown }).ref;
    if (typeof ref !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(ref)) {
      clearPendingBill();
      return null;
    }
    if (!Number.isFinite(parsed.savedAt) || Date.now() - (parsed.savedAt as number) > MAX_CART_AGE_MS) {
      clearPendingBill();
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

export function clearPendingBill(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(PAYLOAD_KEY);
  } catch {
    // Nothing to clear.
  }
}
