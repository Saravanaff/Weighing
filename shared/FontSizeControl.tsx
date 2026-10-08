import { useState } from 'react';
import {
  FONT_SCALE_STEPS,
  currentFontScaleIndex,
  fontScaleStep,
  setFontScaleIndex,
} from './fontScale.ts';

export interface FontSizeControlProps {
  className?: string;
}

/**
 * Two buttons rather than a menu: on a touchscreen the operator is often
 * wearing gloves or holding a scoop, and a dropdown is easy to mis-tap. The
 * current size is spelled out between them so the setting is never a guess,
 * and both ends go inert rather than wrapping round.
 */
export function FontSizeControl({ className }: FontSizeControlProps) {
  const [index, setIndex] = useState(currentFontScaleIndex);
  const step = fontScaleStep(index);
  const atSmallest = index <= 0;
  const atLargest = index >= FONT_SCALE_STEPS.length - 1;

  const move = (delta: number) => {
    const next = Math.min(FONT_SCALE_STEPS.length - 1, Math.max(0, index + delta));
    if (next === index) return;
    setFontScaleIndex(next);
    setIndex(next);
  };

  return (
    <div className={`font-size-control${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="font-size-btn"
        onClick={() => move(-1)}
        disabled={atSmallest}
        aria-label="Decrease text size"
        title="Smaller text"
      >
        A−
      </button>
      <span className="font-size-value" aria-live="polite">
        {step.label}
      </span>
      <button
        type="button"
        className="font-size-btn"
        onClick={() => move(1)}
        disabled={atLargest}
        aria-label="Increase text size"
        title="Larger text"
      >
        A+
      </button>
    </div>
  );
}
