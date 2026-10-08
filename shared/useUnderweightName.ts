import { useEffect } from 'react';
import {
  orderLangs,
  startNameLoop,
  stopNameLoop,
  type NameLoopLang,
  type SpeakName,
} from './multilingualName.ts';

export interface UnderweightNameOptions<T> {
  /** The item being weighed; nothing is spoken without one. */
  item: T | null | undefined;
  /** Every language to cycle through. */
  langs: readonly NameLoopLang[];
  /** The operator's own language, spoken first. */
  preferredLang: NameLoopLang;
  /**
   * True only while the reading is under target. Reaching the target — or
   * overshooting — turns this off, which is what silences the repetition.
   */
  underweight: boolean;
  /** Muted alerts mean no spoken names either. */
  enabled: boolean;
  speak: SpeakName;
  stop: () => void;
}

/**
 * Speaks the item's name in every language for as long as the line is
 * underweight, and stops the moment it is not.
 *
 * The tone loop in `alerts.ts` covers under and over alike; this adds the
 * spoken name for underweight only, where more material is still being added.
 */
export function useUnderweightName<T>({
  item,
  langs,
  preferredLang,
  underweight,
  enabled,
  speak,
  stop,
}: UnderweightNameOptions<T>): void {
  const order = orderLangs(preferredLang, langs);
  const orderKey = order.join(',');

  useEffect(() => {
    if (!underweight || !enabled || item == null) {
      stopNameLoop();
      return;
    }
    startNameLoop(item, orderKey.split(',').filter(Boolean), { speak, stop });
  }, [item, orderKey, underweight, enabled, speak, stop]);

  // Leaving the terminal, or changing item, must not leave a name repeating.
  useEffect(() => () => stopNameLoop(), []);
}
