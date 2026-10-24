import { useEffect, useMemo, useRef, useState } from 'react';
import { VOICE_LANGS } from './lib/items.ts';
import {
  evaluateReading,
  fmtWeight,
  localIsoNow,
  round3,
  type ReadingVerdict,
} from './lib/weights.ts';
import { TareBaseline } from '../../shared/tareBaseline.ts';
import { useAutoAdvance } from '../../shared/useAutoAdvance.ts';
import { isMaizeItem } from '../../shared/maize.ts';
import { useWeightSource } from './lib/weightSource.ts';
import { preloadAll, stopSpeaking } from './lib/tts.ts';
import { api, type WeighingPayload } from './api.ts';
import { WeighingTerminal } from './stages/WeighingTerminal.tsx';
import { ScaleConnection } from './components/ScaleConnection.tsx';
import type { Bill, CartItem, Formula, Item, LangCode } from './lib/types.ts';
import { FontSizeControl } from '../../shared/FontSizeControl.tsx';
import { installPanelSwitch } from '../../shared/panelSwitch.ts';
import { ShutdownButton } from '../../shared/ShutdownButton.tsx';
import { BatchPrompt } from '../../shared/BatchPrompt.tsx';
import { ScaleSettings, type ScaleLinkState } from '../../shared/ScaleSettings.tsx';
import { roundOffWeight, roundTargetWeight } from '../../shared/targetWeight.ts';
import {
  clearPendingBill,
  clearStoredCart,
  loadCart,
  loadPendingBill,
  saveCart,
  savePendingBill,
} from '../../shared/cartStorage.ts';

type Stage = 'select' | 'weighing' | 'done';

/**
 * Must satisfy the server's `/^[A-Za-z0-9_-]{8,64}$/` reference check, or the
 * reference is silently dropped and a retry saves the batch a second time.
 * `getRandomValues` is available over plain http; `randomUUID` is not.
 */
const uid = () => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
};

const NEUTRAL: ReadingVerdict = {
  type: 'neutral',
  title: '',
  detail: '',
  difference: null,
  correct: false,
};

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface StaffSelectProps {
  formulas: Formula[];
  itemsLoading: boolean;
  onFormula: (formula: Formula) => void;
  onReload: () => void;
}

function StaffSelect({ formulas, itemsLoading, onFormula, onReload }: StaffSelectProps) {
  return (
    <section className="stage staff-select">
      <div className="staff-select-intro">
        <div className="screen-title">STAFF WEIGHING TERMINAL</div>
        <div className="screen-sub">
          Load a formula and weigh each item to its exact target.
        </div>
      </div>

      <div className="staff-select-grid single">
        <div className="panel staff-panel staff-panel-formula">
          <div className="panel-title">
            <span className="panel-num">1</span>
            <span>LOAD A FORMULA</span>
            {formulas.length > 0 && <span className="panel-count">{formulas.length}</span>}
          </div>
          <div className="staff-panel-sub">
            Weigh a pre-set combination exactly. The next item unlocks only once the target is met.
          </div>
          <div className="staff-list-scroll">
            {itemsLoading ? (
              <div className="panel-placeholder">Loading formulas…</div>
            ) : formulas.length === 0 ? (
              // A formula created in the admin portal after this page loaded
              // will not appear on its own, and telling staff to go and use a
              // portal they cannot reach is a dead end with no way out but a
              // manual browser refresh. Offer the reload.
              <div className="panel-placeholder">
                <p>No formulas available. Create one in the admin portal first.</p>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={onReload}
                >
                  RELOAD FORMULAS
                </button>
              </div>
            ) : (
              formulas.map((formula: Formula) => (
                <button
                  key={formula.id}
                  type="button"
                  className="staff-row"
                  onClick={() => onFormula(formula)}
                >
                  <div className="staff-row-main">
                    <div className="staff-row-name">{formula.name}</div>
                    <div className="staff-row-meta">
                      {formula.itemCount} item{formula.itemCount === 1 ? '' : 's'} ·{' '}
                      {fmtWeight(formula.totalWeight)}
                    </div>
                  </div>
                  <span className="staff-row-action">START</span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

interface StaffDoneProps {
  bill: Bill | null;
  saving: boolean;
  saveError: string;
  onRetry: () => void;
  onAgain: () => void;
}

function StaffDone({ bill, saving, saveError, onRetry, onAgain }: StaffDoneProps) {
  return (
    <section className="stage staff-done">
      <div className="panel staff-done-card">
        <div className="staff-done-icon">{bill ? '✓' : saving ? '…' : '!'}</div>
        <div className="screen-title">{saving ? 'SAVING WEIGHING…' : bill ? 'WEIGHING RECORDED' : 'SAVE FAILED'}</div>
        {bill && (
          <div className="staff-done-facts">
            <div className="staff-done-fact">
              <span className="staff-done-label">Bill No.</span>
              <span className="staff-done-value">{bill.batchNo}</span>
            </div>
            <div className="staff-done-fact">
              <span className="staff-done-label">Items Weighed</span>
              <span className="staff-done-value">{bill.itemCount}</span>
            </div>
            <div className="staff-done-fact">
              <span className="staff-done-label">Total Weight</span>
              <span className="staff-done-value">{fmtWeight(bill.totalWeight)}</span>
            </div>
          </div>
        )}
        {saveError && (
          <div className="error-text">
            {saveError}{' '}
            {onRetry && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
                RETRY SAVE
              </button>
            )}
          </div>
        )}
        {!saving && (
          <button type="button" className="btn btn-primary btn-lg" onClick={onAgain}>
            WEIGH ANOTHER
          </button>
        )}
      </div>
    </section>
  );
}

export default function StaffApp() {
  const [items, setItems] = useState<Item[]>([]);
  const [formulas, setFormulas] = useState<Formula[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // No language picker any more: every announcement leads in English and the
  // underweight repeat walks the remaining languages on its own.
  const voiceLang: LangCode = 'en';

  const [stage, setStage] = useState<Stage>('select');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  // True when a weighing was restored from storage, so the operator is told
  // rather than silently dropped back into a half-finished bill.
  const [resumed, setResumed] = useState(false);

  const [savedBill, setSavedBill] = useState<Bill | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [lastPayload, setLastPayload] = useState<WeighingPayload | null>(null);

  // Ctrl+Alt+A hands over to the admin portal. Each switch loads a fresh page
  // (see shared/panelSwitch.ts), so a formula created in the admin portal
  // appears on this staff tablet the moment the operator returns.
  useEffect(installPanelSwitch, []);

  const { getReading, live, device, port, baudRates,
    deviceBusy, deviceError, connect, disconnect } =
    useWeightSource();
  const tare = useMemo(() => new TareBaseline(), []);

  // The header trigger stands in for the old SCALE ONLINE / SCALE OFFLINE badge,
  // so the operator can still see the link state without opening the panel.
  const scaleLinkState: ScaleLinkState = deviceError
    ? 'error'
    : device.connected
      ? 'online'
      : 'offline';
  const scaleLinkLabel = deviceError
    ? `SCALE ERROR: ${deviceError}`
    : device.connected
      ? `SCALE ONLINE (${device.port ?? 'connected'})`
      : 'SCALE OFFLINE';
  // Guards against a second POST for the same weighing. The button is disabled
  // while saving, but a fast double tap, an Enter keypress, or a retried click
  // can all fire before React re-renders, which previously created two bills.
  const savingRef = useRef(false);
  const advancedUidRef = useRef<string | null>(null);

  async function loadData() {
    setItemsLoading(true);
    setLoadError('');
    // Loaded independently: one failing catalog must not hide the other, since
    // a staff member can still weigh a formula whose items are not loaded yet.
    const [itemResult, formulaResult] = await Promise.allSettled([
      api.getItems(),
      api.getFormulas(),
    ]);
    const problems: string[] = [];
    if (itemResult.status === 'fulfilled') {
      setItems(Array.isArray(itemResult.value) ? itemResult.value : []);
    } else {
      problems.push(`items: ${errText(itemResult.reason)}`);
    }
    if (formulaResult.status === 'fulfilled') {
      setFormulas(Array.isArray(formulaResult.value) ? formulaResult.value : []);
    } else {
      problems.push(`formulas: ${errText(formulaResult.reason)}`);
    }
    setLoadError(problems.join(' · '));
    setItemsLoading(false);
  }

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (items.length > 0) preloadAll(items, VOICE_LANGS);
  }, [items]);

  // Resume a weighing that was interrupted by a refresh or a locked screen.
  // Completed lines keep the weight already measured and the terminal picks up
  // at the first line still to do, so nothing already recorded is re-poured.
  useEffect(() => {
    const pending = loadPendingBill<WeighingPayload>();
    if (pending) {
      setLastPayload(pending);
      setSavedBill(null);
      // The bill never reached the server. Without a real message the screen
      // renders "SAVE FAILED" with no explanation and, because the retry button
      // lives behind this same flag, no way to send it at all -- leaving discard
      // as the only option for a batch that was physically poured.
      setSaveError('This weighing was not stored before the app closed');
      setStage('done');
      return;
    }
    const stored = loadCart();
    if (!stored) return;
    // If the item master has since changed, rebuild names from it where we can.
    const restored: CartItem[] = stored.lines.map((line) => {
      const item = items.find((candidate: Item) => candidate.id === line.id);
      return {
        uid: line.uid,
        id: line.id,
        slug: item ? item.slug : line.slug,
        name: item ? item.name : line.name,
        names: item ? item.names : { en: line.name, hi: '', bn: '', ta: '' },
        imagePath: item ? item.imagePath ?? null : line.imagePath ?? null,
        required: roundTargetWeight(line.required),
        status: line.status,
        actual: line.actual ?? null,
        formulaName: line.formulaName ?? stored.formulaName,
        formulaId: line.formulaId ?? stored.formulaId,
      };
    });
    const firstPending = restored.findIndex((line) => line.status !== 'completed');
    if (firstPending === -1) {
      clearStoredCart();
      return;
    }
    setCart(restored);
    setActiveIndex(firstPending);
    setResumed(true);
    // The finished lines are still on the pan, so whatever the scale is reading
    // now becomes the zero the resumed line is measured against.
    tare.zeroAt(getReading());
    setStage('weighing');
    // Reached once on mount: the item master is still loading, and a second
    // pass would fight the operator who may already have moved on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A bill that failed to save is kept in storage, so a reload while the
  // failure screen is up can still retry it instead of losing the batch.
  useEffect(() => {
    if (stage === 'done' && lastPayload && !savedBill) savePendingBill(lastPayload);
  }, [stage, lastPayload, savedBill]);

  useEffect(() => {
    if (savedBill) clearPendingBill();
  }, [savedBill]);

  const activeItem = stage === 'weighing' ? cart[activeIndex] : null;
  const accumulated = getReading();
  // The scale is never re-zeroed and nothing is taken off the pan between lines,
  // so this reading is the total of every item weighed so far. Each line is
  // judged on what has been added since it started, which is the reading minus
  // the zero point captured then.
  // A scale that sits below zero with an empty pan says so in its very first
  // reading, which can land after START WEIGHING if the port was still opening.
  // Taking that as the zero point is what keeps a line from recording less than
  // the operator actually poured. Done during render rather than in the effect
  // below, so the next read already sees the corrected zero instead of one
  // render where the terminal and the verdict disagree.
  tare.adoptEmptyPan(accumulated);
  const netWeight = tare.net(accumulated);
  const loadRemoved = tare.underBase(accumulated);
  const status: ReadingVerdict = activeItem
    ? evaluateReading(activeItem.required, netWeight)
    : NEUTRAL;
  // A correct weight is accepted as soon as it arrives: the four second
  // auto-advance below is the only delay, so the operator sees TARGET REACHED
  // and the line moves on whether or not the machine ever calls the frame
  // stable. Requiring the scale's own stable flag here is what used to wedge a
  // line on TARGET REACHED forever — a load cell that dithers a gram at rest
  // never produces three byte-identical frames — and the delay it added bought
  // nothing the countdown does not already provide.
  const nextEnabled = status.correct;
  // The PLC output is wired to the Maize line only. It is held on for as long
  // as a maize line is the one being poured, and it drops the instant that line
  // reaches its target — not when the four-second auto-advance finally moves
  // on, because the machine downstream has to see the weight the moment it is
  // reached. No other item ever touches this output.
  const plcOn =
    stage === 'weighing' && activeItem != null && isMaizeItem(activeItem) && !status.correct;
  useEffect(() => {
    void api
      .setPlcOutput(plcOn ? 'on' : 'off')
      .catch((err) => console.error('PLC output state failed:', err));
  }, [plcOn]);
  const autoAdvanceMs = useAutoAdvance({
    ready: nextEnabled,
    token: activeItem ? `${activeIndex}:${activeItem.uid}:${activeItem.required}` : null,
    onAdvance: handleNext,
  });

  const [batchInfo, setBatchInfo] = useState<{ total: number; current: number } | null>(null);
  const [pendingFormula, setPendingFormula] = useState<Formula | null>(null);

  function startFormula(formula: Formula) {
    setPendingFormula(formula);
  }

  function startFormulaBatches(formula: Formula, batches: number) {
    const lines: CartItem[] = formula.lines.map((line) => {
      const item = items.find((candidate: Item) => candidate.id === line.itemId);
      return {
        uid: uid(),
        id: line.itemId ?? null,
        slug: item ? item.slug : '',
        name: item ? item.name : line.itemName,
        names: item ? item.names : { en: line.itemName, hi: '', bn: '', ta: '' },
        imagePath: item ? item.imagePath ?? null : null,
        required: roundTargetWeight(line.requiredWeight),
        status: 'pending',
        formulaId: formula.id,
        formulaName: formula.name,
      };
    });
    if (lines.length === 0) return;
    stopSpeaking();
    setBatchInfo({ total: Math.max(1, batches), current: 1 });
    setCart(lines);
    setActiveIndex(0);
    setSaveError('');
    setLastPayload(null);
    // Whatever the pan is carrying when the batch starts is not part of the
    // batch, so it is zeroed out here instead of being asked for as the first
    // line's weight.
    tare.zeroAt(getReading());
    advancedUidRef.current = null;
    setResumed(false);
    clearStoredCart();
    clearPendingBill();
    saveCart(lines, formula.id);
    setStage('weighing');
  }

  function cancelWeighing() {
    // Every completed line here is material that was physically poured and
    // measured. A gloved mis-tap must not throw away an hour of it without
    // asking, so confirm before anything is dropped.
    if (cart.length > 0) {
      const completed = cart.filter((line) => line.status === 'completed').length;
      const discard = window.confirm(
        completed > 0
          ? `Cancel this weighing? ${completed} completed line${completed === 1 ? '' : 's'} will be discarded and nothing will be recorded.`
          : 'Cancel this weighing and clear the list?',
      );
      if (!discard) return;
    }
    stopSpeaking();
    setCart([]);
    setActiveIndex(0);
    setSavedBill(null);
    setSaveError('');
    setLastPayload(null);
    tare.reset();
    advancedUidRef.current = null;
    setResumed(false);
    clearStoredCart();
    clearPendingBill();
    setStage('select');
  }

  function saveBill(payload: WeighingPayload) {
    // Synchronous guard: a second call in the same tick must be dropped before
    // it can reach the network, otherwise one weighing produces two bills.
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError('');
    // Leave the weighing stage before awaiting, so the terminal and its NEXT
    // button unmount immediately and cannot be pressed again while saving.
    setStage('done');
    api
      .saveWeighing(payload)
      .then((bill: Bill) => {
        setSavedBill(bill);
        // The bill is on the server now, so the stored cart has nothing left to
        // represent. Left in place, a reload after this screen restored the
        // whole formula and the operator weighed it a second time.
        clearStoredCart();
      })
      .catch((err) => {
        setSaveError(errText(err));
      })
      .finally(() => {
        savingRef.current = false;
        setSaving(false);
      });
  }

  function retrySave() {
    if (!lastPayload) return;
    saveBill(lastPayload);
  }

  function handleNext() {
    if (!activeItem) return;
    // A tap on NEXT can land in the same moment the auto-advance timer fires.
    // Both would advance the same line, so the second one is dropped.
    if (advancedUidRef.current === activeItem.uid) return;
    const reading = getReading();
    // The line is judged and recorded on the net weight, which is the item on
    // top of the zero point and not the total the scale is displaying.
    const current = tare.net(reading);
    // The same verdict the operator is looking at. Comparing the raw reading
    // against the target instead is stricter than the screen: a 51 kg target
    // is accepted on screen from 51.000 up to 51.999, because the reading is
    // rounded down to whole kilograms the way the target is, but the raw
    // comparison only matched 51.000 exactly. A scale sitting anywhere in that
    // kilogram therefore showed WEIGHT ACCEPTED, armed the auto-advance
    // countdown, and then had the advance silently dropped here, so the line
    // never moved on. One source of truth means the two cannot disagree.
    if (current == null || !evaluateReading(activeItem.required, current).correct) return;
    // Only now is the line really being advanced, so this is the point at which
    // to claim it. Claiming it before the guards passed meant a tap that landed
    // on an off-target reading burned the line's single attempt and it could
    // never advance afterwards, because every later call saw the uid already
    // taken and returned.
    advancedUidRef.current = activeItem.uid;
    // Record the weight of this item alone, so a bill shows target vs measured
    // for the item and not for the whole batch sitting on the pan.
    const actual = round3(current);
    const completed: CartItem[] = cart.map((item: CartItem, index: number) =>
      index === activeIndex ? { ...item, status: 'completed', actual } : item,
    );
    setCart(completed);
    saveCart(completed, null);
    // Nothing is taken off the scale between lines, so the total now on the pan
    // becomes the zero the next line is measured against. That is what stops the
    // weight just accepted from satisfying the next line: the next line starts
    // from a net of zero, not from the whole batch.
    tare.carry(reading);
    if (activeIndex < cart.length - 1) {
      setActiveIndex(activeIndex + 1);
    } else {
      completeWeighing(completed);
    }
  }

  /**
   * Turn a finished cart into the bill payload and hand it to the server.
   *
   * Shared by the normal advance off the last line and by a skip off the last
   * line, so both close the weighing with the same shape of bill.
   */
  function completeWeighing(completed: CartItem[]) {
    const lines = completed.map((item: CartItem) => ({
      itemId: item.id,
      itemName: item.name,
      requiredWeight: item.required,
      actualWeight: item.actual == null ? null : roundOffWeight(item.actual),
    }));
    const payload: WeighingPayload = {
      weighedAt: localIsoNow(),
      lines,
      formulaName: completed[0]?.formulaName || activeItem?.formulaName || null,
      ref: uid(),
    };
    if (batchInfo && batchInfo.current < batchInfo.total) {
      setBatchInfo({ ...batchInfo, current: batchInfo.current + 1 });
      const formulaId = completed[0]?.formulaId || activeItem?.formulaId;
      const formula = formulas.find((f) => f.id === formulaId);
      if (formula) {
        const newLines: CartItem[] = [];
        formula.lines.forEach((line) => {
          const item = items.find((candidate: Item) => candidate.id === line.itemId);
          newLines.push({
            uid: uid(),
            id: line.itemId ?? null,
            slug: item ? item.slug : '',
            name: item ? item.name : line.itemName,
            names: item ? item.names : { en: line.itemName, hi: '', bn: '', ta: '' },
            imagePath: item ? item.imagePath ?? null : null,
            required: roundTargetWeight(line.requiredWeight),
            status: 'pending',
            formulaId: formula.id,
            formulaName: formula.name,
          });
        });
        if (newLines.length > 0) {
          setCart(newLines);
          setActiveIndex(0);
          tare.zeroAt(getReading());
          advancedUidRef.current = null;
          setResumed(false);
          clearStoredCart();
          clearPendingBill();
          saveCart(newLines, formula.id);
          setStage('weighing');
          return;
        }
      }
    }
    setBatchInfo(null);
    setLastPayload(payload);
    saveBill(payload);
  }

  /**
   * Move past the current line without weighing it.
   *
   * For a line that cannot be completed as weighed — the batch was started at
   * the wrong scale reading, or the wrong material went into the pan. The only
   * escape used to be CANCEL WEIGHING, which throws away every line already
   * weighed. This keeps them all and records only this line as skipped, so the
   * bill shows it as never weighed rather than as a wrong weight.
   */
  function skipItem() {
    if (!activeItem) return;
    // Same claim as handleNext: a tap landing on the auto-advance moment must
    // not advance the same line twice.
    if (advancedUidRef.current === activeItem.uid) return;
    const isLast = activeIndex >= cart.length - 1;
    const skip = window.confirm(
      isLast
        ? `Skip ${activeItem.name}? It will be recorded with no weight, and the weighing will be saved and closed.`
        : `Skip ${activeItem.name}? It will be recorded with no weight and the next item will start.`,
    );
    if (!skip) return;
    advancedUidRef.current = activeItem.uid;
    const reading = getReading();
    // Built from the current cart rather than via the updater, because the last
    // line is saved in the same tick and the updater's result is not readable
    // until the next render.
    const skipped: CartItem[] = cart.map((item: CartItem, index: number) =>
      index === activeIndex ? { ...item, status: 'completed', actual: null } : item,
    );
    setCart(skipped);
    saveCart(skipped, null);
    // The pan still holds whatever was poured, so what it carries now becomes
    // the next line's zero — exactly as an accepted line would have set it.
    tare.carry(reading);
    if (!isLast) {
      setActiveIndex(activeIndex + 1);
    } else {
      completeWeighing(skipped);
    }
  }
  function startNew() {
    // A bill the server never accepted is the only copy of a real, physically
    // poured batch. One habitual tap on the big primary button must not be
    // enough to throw it away without asking.
    if (lastPayload && !savedBill) {

      const discard = window.confirm(
        'This weighing was never saved to the records. Starting a new one now discards it for good. Discard it?',
      );
      if (!discard) return;
    }
    stopSpeaking();
    setBatchInfo(null);
    setCart([]);
    setActiveIndex(0);
    setSavedBill(null);
    setSaveError('');
    setLastPayload(null);
    tare.reset();
    advancedUidRef.current = null;
    setResumed(false);
    clearStoredCart();
    clearPendingBill();
    setStage('select');
  }

  return (
    <div className="app staff-app">
      <header className="app-header staff-header">
        <div className="brand">
          <span className="brand-glyph">⚖</span>
          <span className="brand-text">
            <span className="brand-name">NAVEEN POULTRY FARM</span>
          </span>
          <span className="staff-header-tag">STAFF TERMINAL</span>
        </div>
        <div className="header-controls">
          <FontSizeControl />
          <ScaleSettings state={scaleLinkState} label={scaleLinkLabel}>
            <ScaleConnection
              device={device}
              port={port}
              baudRates={baudRates}
              deviceBusy={deviceBusy}
              deviceError={deviceError}
              connect={connect}
              disconnect={disconnect}
            />
          </ScaleSettings>
          <ShutdownButton />
        </div>
        <img
          className="app-logo"
          src={`${import.meta.env.BASE_URL}logo.jpeg`}
          alt=""
          width={569}
          height={658}
        />
      </header>

      <main style={{ position: 'relative' }}>
        {loadError && (
          <div className="error-banner">
            Could not load data: {loadError}{' '}
            <button type="button" className="btn btn-secondary btn-sm" onClick={loadData}>
              RETRY
            </button>
          </div>
        )}

        {stage === 'select' && (
          <StaffSelect
            formulas={formulas}
            itemsLoading={itemsLoading}
            onFormula={startFormula}
            onReload={loadData}
          />
        )}

        {resumed && stage === 'weighing' && (
          <div className="error-banner resume-banner">
            This weighing was restored after the page reloaded. Lines already
            weighed are marked complete; check the queue, then carry on from
            the first line still to do.{' '}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={cancelWeighing}
            >
              DISCARD
            </button>
          </div>
        )}

        {stage === 'weighing' && batchInfo && (
          <div style={{ position: 'absolute', top: '70px', left: '10px', background: '#1a73e8', color: '#fff', padding: '4px 12px', fontWeight: 700, fontSize: '1rem', borderRadius: '4px', zIndex: 10 }}>
            Number of Batches: {batchInfo.current} / {batchInfo.total}
          </div>
        )}

        {stage === 'weighing' && (
          <WeighingTerminal
            cart={cart}
            activeIndex={activeIndex}
            activeItem={activeItem}
            status={status}
            autoAdvanceMs={autoAdvanceMs}
            reading={netWeight}
            accumulatedReading={accumulated}
            zeroAt={tare.baseValue()}
            zeroEstablished={tare.isEstablished()}
            loadRemoved={loadRemoved}
            nextEnabled={nextEnabled}
            nextBlockedReason={
              loadRemoved
                ? 'Material came off the scale. Clear the pan and press ZERO HERE, or put the weight back on.'
                : null
            }
            voiceLang={voiceLang}
            device={device}
            live={live}
            onNext={handleNext}
            onZero={() => tare.zeroAt(getReading())}
            onCancel={cancelWeighing}
            onSkip={skipItem}
          />
        )}

        {stage === 'done' && (
          <StaffDone
            bill={savedBill}
            saving={saving}
            saveError={saveError}
            onRetry={retrySave}
            onAgain={startNew}
          />
        )}
      </main>

      <footer className="app-footer no-print">© Copyright Reem Engineering Enterprises</footer>

      {pendingFormula && (
        <BatchPrompt
          formulaName={pendingFormula.name}
          onCancel={() => setPendingFormula(null)}
          onConfirm={(count) => {
            const formula = pendingFormula;
            setPendingFormula(null);
            startFormulaBatches(formula, count);
          }}
        />
      )}
    </div>
  );
}