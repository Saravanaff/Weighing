import { useEffect, useState } from 'react';
import type { ScaleReading } from '../../../shared/scale.ts';
import { roundOffWeight } from '../../../shared/targetWeight.ts';
import { alertsEnabled, primeAlertAudio, toggleAlertsEnabled } from '../../../shared/alerts.ts';
import { secondsLeft } from '../../../shared/useAutoAdvance.ts';
import { useVerdictAlert } from '../../../shared/useVerdictAlert.ts';
import { stopNameLoop as stopUnderweightName } from '../../../shared/multilingualName.ts';
import { useUnderweightName } from '../../../shared/useUnderweightName.ts';
import { fmtSignedDiff, fmtWeight, fmtWeightNoUnit, type ReadingVerdict } from '../lib/weights.ts';
import { speakItem, stopSpeaking, voiceEngine } from '../lib/tts.ts';
import { localizedName, VOICE_LANGS } from '../lib/items.ts';
import { itemImageUrl } from '../lib/config.ts';
import { Scale } from '../components/Scale.tsx';
import type { DeviceState } from '../lib/weightSource.ts';
import type { CartItem, LangCode } from '../lib/types.ts';

const voiceLabel = (code: LangCode): string => {
  const lang = VOICE_LANGS.find((candidate) => candidate.code === code);
  return lang ? lang.label.split(' / ')[0] : code.toUpperCase();
};

const deviceStateLabel = (device: Partial<DeviceState>): string => {
  if (device.status === 'connected') return 'ONLINE';
  if (device.status === 'connecting') return 'CONNECTING';
  if (device.status === 'reconnecting') return 'RECONNECTING';
  if (device.status === 'failed') return 'UNAVAILABLE';
  return 'OFFLINE';
};

export interface WeighingTerminalProps {
  cart: CartItem[];
  activeIndex: number;
  activeItem: CartItem | null;
  status: ReadingVerdict;
  /**
   * Net weight of the item being weighed: the scale's reading minus the weight
   * already on the pan when this line started. Null when nothing is arriving.
   */
  reading: number | null;
  /** What the scale itself is reading, i.e. the net weight plus the zero point. */
  accumulatedReading?: number | null;
  /**
   * The weight already on the pan, treated as zero for this line. Negative on a
   * scale whose empty pan reads below zero.
   */
  zeroAt?: number;
  /** False while the scale has not yet said what an empty pan reads. */
  zeroEstablished?: boolean;
  /** True when the reading has fallen below the zero point, i.e. material came off. */
  loadRemoved?: boolean;
  nextEnabled: boolean;
  /**
   * True when the line is at its target but the machine has never reported the
   * reading as settled. A scale that dithers a gram or two at rest never
   * produces the three identical frames the server looks for, so without an
   * escape the operator has no way forward but to abandon the whole batch.
   */
  forceNextEnabled?: boolean;
  /** Why the line is not advancing yet, e.g. the scale is not settled. */
  nextBlockedReason?: string | null;
  /**
   * Milliseconds until the line advances by itself, 0 when not counting.
   */
  autoAdvanceMs?: number;
  voiceLang: LangCode;
  device?: DeviceState | null;
  live?: ScaleReading | null;
  /** Called with true to advance a settled-looking line the machine never flagged. */
  onNext?: (force?: boolean) => void;
  /** Re-take the zero point from the current reading. */
  onZero?: () => void;
  onCancel?: () => void;
}

export function WeighingTerminal({
  cart,
  activeIndex,
  activeItem,
  status,
  reading,
  accumulatedReading = null,
  zeroAt = 0,
  zeroEstablished = true,
  loadRemoved = false,
  nextEnabled,
  forceNextEnabled = false,
  nextBlockedReason = null,
  autoAdvanceMs = 0,
  voiceLang,
  device = null,
  live = null,
  onNext,
  onZero,
  onCancel,
}: WeighingTerminalProps) {
  const [alertsOn, setAlertsOn] = useState(alertsEnabled);
  const connected = Boolean(device?.connected);
  const scaleLabel = deviceStateLabel(device ?? {});
  const offline = !connected;
  const current = reading;
  // Port is open but no usable reading: either the scale is silent, or it is
  // sending bytes we cannot frame. Both are almost always a wiring, cable-type
  // or baud-rate mismatch rather than a dead cable.
  const noReading = connected && current == null;
  // What the readouts show. The reading is rounded to whole kilograms exactly
  // like the target, so the operator sees the same figure the verdict used: a
  // scale sitting on 51.2 kg for a 51 kg line reads 51.000 and is accepted,
  // rather than showing 51.200 next to a target it can never match.
  const shown = current == null ? null : roundOffWeight(current);
  // The scale is never re-zeroed, so its own display is the total on the pan.
  // Shown next to the net weight so the two figures cannot be confused.
  const panTotal = accumulatedReading == null ? null : roundOffWeight(accumulatedReading);

  useEffect(() => {
    if (!activeItem || status.type === 'underweight') return;
    // A deliberate repeat (new item, new language) wins over the loop: it stops
    // the cycle so the two never talk over each other.
    stopUnderweightName();
    speakItem(activeItem, voiceLang);
  }, [activeItem, status.type, voiceLang]);

  // tts.ts promises that a screen change alone stops the voice. Without an
  // unmount cleanup the item name keeps talking over whatever replaced this
  // terminal, because nothing cancels the in-flight utterance.
  useEffect(() => () => {
    stopUnderweightName();
    stopSpeaking();
  }, []);

  // Underweight only: the name repeats in every language until the target is
  // reached, which is when `status.type` flips and the loop stops itself.
  useUnderweightName({
    item: activeItem,
    langs: VOICE_LANGS.map((lang) => lang.code),
    preferredLang: voiceLang,
    underweight: status.type === 'underweight',
    enabled: alertsOn,
    speak: (item, lang, onDone) => speakItem(item as CartItem, lang as LangCode, onDone),
    stop: stopSpeaking,
  });

  // Audible under/over/accepted cues, and the first tap also unlocks the
  // audio context that browsers keep suspended until a user gesture.
  useEffect(() => {
    primeAlertAudio();
  }, []);

  useVerdictAlert(status.type, { enabled: alertsOn });

  const countingDown = autoAdvanceMs > 0;
  const handleNext = onNext ?? (() => {});

  if (!activeItem) return null;

  const diffZone =
    status.difference == null
      ? 'neutral'
      : status.difference === 0
        ? 'zero'
        : status.difference < 0
          ? 'neg'
          : 'pos';

  return (
    <section className="stage terminal">
      <div className="terminal-bar">
        <span className="terminal-title">WEIGHING TERMINAL</span>
        <span className="terminal-meta">
          <span className="terminal-item">
            Machine: <b>YH-T7E</b>
          </span>
          <span className="terminal-item">
            Status:{' '}
            <b className={offline ? 'b-warn' : 'b-ready'}>{offline ? 'AWAITING DEVICE' : 'READY'}</b>
          </span>
          <span
            className={`terminal-item terminal-scale terminal-scale-${scaleLabel.toLowerCase()}`}
          >
            Scale: <b>{scaleLabel}</b>
          </span>
          <span className="terminal-item terminal-source">LIVE SERIAL READING (RS232)</span>
          <span className="terminal-item terminal-source">
            Voice: {voiceLabel(voiceLang)} · ENGINE {voiceEngine()}
          </span>
          <button
            type="button"
            className={`alert-toggle ${alertsOn ? 'on' : 'off'}`}
            aria-pressed={alertsOn}
            title={
              alertsOn
                ? 'Weight alerts on — rings continuously while under or over target'
                : 'Weight alerts muted — turn the tones back on'
            }
            onClick={() => {
              primeAlertAudio();
              setAlertsOn(toggleAlertsEnabled());
            }}
          >
            {alertsOn ? '🔔 ALERTS ON' : '🔕 ALERTS MUTED'}
          </button>
        </span>
        {onCancel && (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={onCancel}
          >
            CANCEL WEIGHING
          </button>
        )}
      </div>

      <div className="terminal-layout">
        <aside className="panel queue-panel">
          <div className="panel-title">WEIGHING QUEUE</div>
          <div className="queue">
            <div className="queue-row queue-head">
              <span>No.</span>
              <span>Item</span>
              <span>Required</span>
              <span>Status</span>
            </div>
            {cart.map((item: CartItem, index: number) => (
              <div
                key={item.uid}
                className={`queue-row ${item.status}${index === activeIndex ? ' current' : ''}`}
                aria-current={index === activeIndex ? 'step' : undefined}
              >
                <span className="num">{String(index + 1).padStart(2, '0')}</span>
                <span className="queue-item">
                  {itemImageUrl(item.imagePath) && (
                    <img
                      className="queue-thumb"
                      src={itemImageUrl(item.imagePath) as string}
                      alt=""
                      aria-hidden="true"
                    />
                  )}
                  <span className="queue-item-text">
                    <span className="queue-item-en">{item.name}</span>
                    <span className="queue-item-local">{localizedName(item, voiceLang)}</span>
                  </span>
                </span>
                <span className="num">{fmtWeight(item.required)}</span>
                <span className={`queue-status ${item.status}`}>
                  {item.status === 'completed' ? '✓ COMPLETE' : item.status.toUpperCase()}
                </span>
              </div>
            ))}
          </div>
        </aside>

        <div className="panel scale-panel">
          <div className="current-item">
            <div className="current-item-label">CURRENT ITEM</div>
            {itemImageUrl(activeItem.imagePath) && (
              <img
                className="current-item-photo"
                src={itemImageUrl(activeItem.imagePath) as string}
                alt={`${activeItem.name} picture`}
              />
            )}
            <div className="current-item-name">{activeItem.name.toUpperCase()}</div>
            <div className="current-item-local">{localizedName(activeItem, voiceLang)}</div>
            <div className="current-item-required">
              Required Weight: {fmtWeight(activeItem.required)}
              <button
                type="button"
                className="speaker-btn"
                onClick={() => speakItem(activeItem, voiceLang)}
                aria-label={`Replay item name ${activeItem.name}`}
                title="Replay item name"
              >
                🔊
              </button>
            </div>
          </div>

          <div className="scale-wrap">
            <Scale value={shown} liveStable={live?.stable ?? null} />
          </div>
        </div>

        <aside className="panel input-panel">
          <div className="panel-title">LIVE WEIGHT READOUT</div>

          <div className="metric">
            <div className="metric-label">Required Weight</div>
            <div className="metric-value">{fmtWeight(activeItem.required)}</div>
          </div>

          <div className="metric">
            <div className="metric-label">
              {zeroAt > 0
                ? 'Already On The Scale (zero point)'
                : zeroAt < 0
                  ? 'Scale Reads Low By (zero point)'
                  : 'Zero Point'}
            </div>
            <div className="metric-value">
              {zeroEstablished ? fmtWeight(zeroAt) : 'not set yet'}
            </div>
            <div className="metric-hint">
              {zeroEstablished
                ? zeroAt < 0
                  ? 'This scale reads below zero with an empty pan. It is added back to every weight, so your figures are correct.'
                  : zeroAt > 0
                    ? 'Finished items are left on the pan, so this is subtracted for you.'
                    : 'The scale was zeroed when weighing started. Clear the pan before the first item.'
                : 'Waiting for the scale to report. The pan is treated as zero until it does.'}
              {onZero && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm btn-zero-here"
                  onClick={onZero}
                  title="Treat the scale reading right now as zero"
                >
                  ZERO HERE
                </button>
              )}
            </div>
          </div>

          <div className="metric metric-input metric-device">
            <div className="metric-label">Current Item Weight</div>
            <div className="live-reading">
              <span className={`live-reading-value ${connected ? '' : 'muted'}`}>
                {shown == null ? '—.———' : fmtWeightNoUnit(shown)}
              </span>
              <span className="unit">kg</span>
              {connected && live?.stable ? <span className="live-stable-badge">STABLE</span> : null}
            </div>
            {panTotal != null && zeroAt > 0 && (
              <div className="metric-hint">
                The scale is reading {fmtWeight(panTotal)} in total. Leave the finished item on
                and add the next one on top — the software takes the difference.
              </div>
            )}
            <div className="metric-hint">
              {connected
                ? `Reading from YH-T7E over RS232 (${device?.port} @ ${device?.baudRate} baud)`
                : `Waiting for ${device?.port || 'the scale'}…`}
            </div>
            {offline && (
              <div className="device-error">
                {device?.message || 'The serial scale is offline.'} Select the USB adapter and
                press CONNECT in the scale settings at the top of the screen.
              </div>
            )}
            {noReading && (
              <div className="device-error">
                {(device?.bytesReceived ?? 0) > 0
                  ? `Port is open and ${device?.bytesReceived ?? 0} bytes have arrived, but none are valid YH-T7E weight frames.`
                  : 'Port is open but the scale has sent no data at all.'}{' '}
                Check the RS232 cable (TX/RX swapped, or a TTL cable instead of
                RS232) and the baud rate.
              </div>
            )}
          </div>

          <div className="metric">
            <div className="metric-label">Difference</div>
            <div className={`metric-value diff-${diffZone}`}>
              {status.difference == null ? '—' : fmtSignedDiff(status.difference)}
            </div>
          </div>

          {loadRemoved && !offline && (
            <div className="status-box status-device" role="alert">
              <div className="status-title">LOAD REMOVED</div>
              <div className="status-detail">
                The scale is reading below the {fmtWeight(zeroAt)} it was zeroed at, so something
                came off the pan. Put it back, or clear the pan and press ZERO HERE. This line
                cannot be finished until the zero point matches the pan again.
              </div>
            </div>
          )}

          {offline ? (
            <div className="status-box status-device">
              <div className="status-title">DEVICE OFFLINE</div>
              <div className="status-detail">
                {device?.message || 'Waiting for the scale to connect…'}
              </div>
            </div>
          ) : (
            <div className={`status-box status-${status.type}`}>
              <div className="status-title">{status.title}</div>
              <div className="status-detail">{status.detail}</div>
            </div>
          )}

          {status.correct && !offline && (
            <div className="status-box status-auto-advance" role="status" aria-live="polite">
              <div className="status-title">
                {countingDown ? `TARGET REACHED — NEXT IN ${secondsLeft(autoAdvanceMs)}` : 'TARGET REACHED'}
              </div>
              <div className="status-detail">
                {countingDown
                  ? 'Moving on by itself. Leave this item on the scale and add the next one on top.'
                  : 'Waiting for the scale to report this reading as settled.'}
              </div>
            </div>
          )}

          {forceNextEnabled && !offline && (
            <button
              type="button"
              className="btn btn-primary btn-next-line"
              onClick={() => handleNext(true)}
            >
              NEXT LINE
            </button>
          )}

          {!nextEnabled && nextBlockedReason && !offline && (
            <div className="metric-hint next-blocked">{nextBlockedReason}</div>
          )}
        </aside>
      </div>
    </section>
  );
}
