import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './scaleSettings.css';

/**
 * Link state shown on the header trigger. The connection detail itself lives in
 * the panel, so the header only has to say enough for the operator to tell
 * whether the scale is live without opening anything.
 */
export type ScaleLinkState = 'online' | 'offline' | 'error';

export interface ScaleSettingsProps {
  state: ScaleLinkState;
  /** Full text for the tooltip and the screen reader, e.g. "SCALE ONLINE". */
  label: string;
  children: ReactNode;
}

/**
 * Header trigger that reveals the scale connection controls in a popover.
 *
 * The connection controls (port list, baud rate, connect/rescan/disconnect and
 * the status line) are roughly 700px wide. Laid out in the header they either
 * forced the bar onto three or four rows on a phone, or, when held on one line,
 * overflowed the row and ran the status text over the trigger. Keeping them in
 * a popover leaves the header holding only the farm name, the text size
 * control, this trigger and the logo, which fits on one line at every width.
 */
export function ScaleSettings({ state, label, children }: ScaleSettingsProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  // The panel is a dialog, so focus moves into it on open and back to the
  // trigger on close, otherwise the next Tab lands on the header behind it.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  // A popover that stays open after the operator taps elsewhere reads as broken,
  // so both an outside tap and Escape close it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="scale-settings" ref={wrapRef}>
      <button
        type="button"
        className="scale-settings-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={label}
      >
        <span className="scale-settings-glyph" aria-hidden="true">
          &#9881;
        </span>
        <span className="scale-settings-mode">SCALE</span>
        <span className={`scale-settings-dot ${state}`} aria-hidden="true" />
      </button>

      {open && (
        <div
          className="scale-settings-panel"
          id={panelId}
          role="dialog"
          aria-label="Scale settings"
          ref={panelRef}
          tabIndex={-1}
        >
          {children}
        </div>
      )}
    </div>
  );
}
