import { useEffect, useRef, useState } from 'react';

type ShutdownState = 'idle' | 'armed' | 'sent' | 'error';

/**
 * The kiosk SHUTDOWN button, shared by the admin and staff terminals.
 *
 * One tap is never enough: the first tap arms the button for a few seconds,
 * the second tap actually powers the machine off. That keeps a stray touch in
 * the middle of a weighing from killing the day's batch. The server delays the
 * OS shutdown a few seconds after it answers, so this button gets to show
 * that the power-off was accepted before the screen goes dark.
 */
export function ShutdownButton() {
  const [state, setState] = useState<ShutdownState>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  function resetLater(ms: number) {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setState('idle'), ms);
  }

  async function confirm() {
    setState('sent');
    try {
      const res = await fetch('/api/shutdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Shutdown failed (HTTP ${res.status})`);
      }
      // The server has accepted. It powers the machine off a few seconds from
      // now, so stay on this message and let the screen go dark by itself.
      resetLater(60000);
    } catch (err) {
      setState('error');
      resetLater(5000);
    }
  }

  function onClick() {
    if (state === 'armed') {
      void confirm();
    } else {
      setState('armed');
      resetLater(6000);
    }
  }

  const label =
    state === 'armed'
      ? '⚠ CONFIRM SHUTDOWN?'
      : state === 'sent'
        ? '⏻ SHUTTING DOWN…'
        : state === 'error'
          ? '✕ SHUTDOWN FAILED'
          : '⏻ SHUTDOWN';

  return (
    <button
      type="button"
      className={`btn btn-danger btn-sm shutdown-btn ${state === 'armed' ? 'armed' : ''}`}
      onClick={onClick}
      title="Turn the machine off. Tap once to arm, tap again to confirm."
      disabled={state === 'sent'}
    >
      {label}
    </button>
  );
}