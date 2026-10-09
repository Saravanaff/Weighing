import { useEffect, useMemo, useRef, useState } from 'react';
import { VOICE_LANGS } from './lib/items.ts';
import {
  evaluateReading,
  localIsoNow,
  parseWeight,
  round3,
  type ReadingVerdict,
} from './lib/weights.ts';
import { TareBaseline } from '../shared/tareBaseline.ts';
import { StabilityLatch } from '../shared/stabilityLatch.ts';
import { useAutoAdvance } from '../shared/useAutoAdvance.ts';
import { useWeightSource } from './lib/weightSource.ts';
import { preloadAll, stopSpeaking } from './lib/tts.ts';
import { api, type WeighingPayload } from './api.ts';
import { ItemSelection } from './stages/ItemSelection.tsx';
import { WeighingTerminal } from './stages/WeighingTerminal.tsx';
import { CompletionScreen } from './stages/CompletionScreen.tsx';
import { ScaleConnection } from './components/ScaleConnection.tsx';
import { ItemsScreen } from './screens/ItemsScreen.tsx';
import { HistoryScreen } from './screens/HistoryScreen.tsx';
import { ReportsScreen } from './screens/ReportsScreen.tsx';
import { FormulasScreen } from './screens/FormulasScreen.tsx';
import { ServerScreen } from './screens/ServerScreen.tsx';
import {
  getServerOrigin,
  isNativeApp,
  needsServerAddress,
  subscribeToServerAddress,
} from './lib/serverAddress.ts';
import { guardBackButton } from './lib/backButton.ts';
import { installPanelSwitch } from '../shared/panelSwitch.ts';
import { ShutdownButton } from '../shared/ShutdownButton.tsx';
import type {
  Bill,
  CartItem,
  CartItemStatus,
  Formula,
  Item,
  LangCode,
  WeighingLine,
} from './lib/types.ts';
import { FontSizeControl } from '../shared/FontSizeControl.tsx';
import { ScaleSettings, type ScaleLinkState } from '../shared/ScaleSettings.tsx';
import { roundOffWeight, roundTargetWeight, targetRoundingNote } from '../shared/targetWeight.ts';
import {
  clearPendingBill,
  clearStoredCart,
  loadCart,
  loadPendingBill,
  saveCart,
  savePendingBill,
} from '../shared/cartStorage.ts';

type ScreenKey = 'weighing' | 'formulas' | 'history' | 'reports' | 'items';
type Stage = 'select' | 'weighing' | 'complete';

const SCREENS: Array<{ key: ScreenKey; label: string }> = [
  { key: 'weighing', label: 'WEIGHING' },
  { key: 'formulas', label: 'FORMULAS' },
  { key: 'history', label: 'HISTORY' },
  { key: 'reports', label: 'REPORTS' },
  { key: 'items', label: 'ITEM MASTER' },
];

/**
 * Must satisfy the server's `/^[A-Za-z0-9_-]{8,64}$/` reference check, or the
 * reference is silently dropped and a retry saves the batch a second time. A
 * 7-character slice looked fine and defeated the whole de-duplication.
 * `getRandomValues` is available over plain http; `randomUUID` is not.
 */
const uid = () => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
};

/**
 * Highest target the terminal will accept. Without a ceiling one extra digit
 * typed into the required-weight box creates a line that can never be reached,
 * and because a line only moves on by itself the only way out was to throw the
 * whole batch away. A poultry ration line is tens of kilograms; 1000 kg is
 * already two orders of magnitude past anything real.
 */
const MAX_TARGET_KG = 1000;
const isMaize = (item: CartItem): boolean => item.name.trim().toLowerCase() === 'maize';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const NEUTRAL: ReadingVerdict = {
  type: 'neutral',
  title: '',
  detail: '',
  difference: null,
  correct: false,
};

export default function App() {
  // Ctrl+Alt+A hands over to the staff terminal. Each switch loads a fresh
  // page (see shared/panelSwitch.ts), so formulas or items added here show up
  // on the staff tablet immediately.
  useEffect(installPanelSwitch, []);

  const [screen, setScreen] = useState<ScreenKey>('weighing');
  const [stage, setStage] = useState<Stage>('select');
  const [items, setItems] = useState<Item[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemsError, setItemsError] = useState('');
  const [formulas, setFormulas] = useState<Formula[]>([]);
  const [formulasError, setFormulasError] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  // True when a weighing was restored from storage, so the operator is told
  // rather than silently dropped back into a half-finished bill.
  const [resumed, setResumed] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [selectedFormulaId, setSelectedFormulaId] = useState<number | null>(null);
  const [reqInput, setReqInput] = useState('');
  const [reqError, setReqError] = useState('');
  // No language picker any more: every announcement leads in English and the
  // underweight repeat walks the remaining languages on its own.
  const voiceLang: LangCode = 'en';
  const [savedBill, setSavedBill] = useState<Bill | null>(null);
  const [billSaving, setBillSaving] = useState(false);
  const [billError, setBillError] = useState('');
  const [billPayload, setBillPayload] = useState<WeighingPayload | null>(null);
  // The Android build cannot do anything until a server address is stored.
  const [showServer, setShowServer] = useState(needsServerAddress);
  const [serverOrigin, setServerOriginState] = useState(getServerOrigin);
  useEffect(() => subscribeToServerAddress(() => {
    setServerOriginState(getServerOrigin());
    setShowServer(needsServerAddress());
  }), []);

  // The Android back button finishes the activity by default. Ask first, but
  // only while there is measured material or an unsaved bill on the terminal.
  useEffect(
    () =>
      guardBackButton(
        () => (cart.length > 0 && stage !== 'complete') || (Boolean(billPayload) && !savedBill),
      ),
    [cart.length, stage, billPayload, savedBill],
  );
  const { getReading, live, device, port, ports, baudRates, deviceBusy, deviceError, refreshScaleInfo, connect, disconnect } =
    useWeightSource();
  const tare = useMemo(() => new TareBaseline(), []);
  const stabilityLatch = useMemo(() => new StabilityLatch(), []);
  const advancedUidRef = useRef<string | null>(null);
  // Guards against a second POST for the same weighing. The button is disabled
  // while saving, but a fast double tap, a retried click, or the auto-advance
  // timer firing in the same tick can all get through before React re-renders.
  const savingRef = useRef(false);

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

  async function loadItems(silent = false) {
    if (!silent) setItemsLoading(true);
    setItemsError('');
    try {
      const list = await api.getItems();
      setItems(Array.isArray(list) ? list : []);
    } catch (err) {
      setItemsError(errText(err));
    } finally {
      setItemsLoading(false);
    }
  }

  async function loadFormulas() {
    setFormulasError('');
    try {
      const list = await api.getFormulas();
      setFormulas(Array.isArray(list) ? list : []);
    } catch (err) {
      setFormulasError(errText(err));
    }
  }

  useEffect(() => {
    loadItems();
    loadFormulas();
    // Re-keyed on the address: without this the item master and formulas stay
    // from the old server after the operator edits the address, so they could
    // build a cart out of one server's items and post it to another.
  }, [serverOrigin]);

  useEffect(() => {
    if (items.length > 0) preloadAll(items, VOICE_LANGS);
  }, [items]);

  useEffect(() => {
    if (selectedItemId != null && !items.some((item: Item) => item.id === selectedItemId)) {
      setSelectedItemId(null);
      setReqInput('');
    }
  }, [items, selectedItemId]);

  // A weighing in progress survives a reload. The Android build can be killed
  // by the OS, the operator can swipe the app away, or a refresh can happen at
  // any point mid-pour; without this the measured weights existed only in React
  // state and the whole batch was lost.
  useEffect(() => {
    const pending = loadPendingBill<WeighingPayload>();
    const stored = loadCart();
    if (pending) {
      setBillPayload(pending);
      setSavedBill(null);
      // The bill never reached the server. Show it as a failed save rather than
      // a clean completion, or the screen renders an empty zero-total table
      // with no RETRY and the only button available destroys the batch.
      setBillError('This weighing was not stored before the app closed');
      setCart(
        (Array.isArray(pending.lines) ? pending.lines : []).map((line: WeighingLine, index: number) => ({
          uid: `${pending.ref || 'pending'}-${index}`,
          id: line.itemId ?? null,
          slug: '',
          name: String(line.itemName || 'Item'),
          names: { en: String(line.itemName || 'Item'), hi: '', bn: '', ta: '' },
          required: line.requiredWeight,
          status: 'completed' as CartItemStatus,
          actual: line.actualWeight ?? null,
        })),
      );
      setStage('complete');
      return;
    }
    if (!stored) return;
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
        // Completed lines keep their measured weight, and the terminal resumes
        // at the first line still to do. Restoring them as pending made the
        // operator re-pour material that had already been recorded.
        status: line.status,
        actual: line.actual ?? null,
        formulaName: line.formulaName ?? stored.formulaName,
        formulaId: line.formulaId ?? stored.formulaId,
      };
    });
    const firstPending = restored.findIndex((line) => line.status !== 'completed');
    if (firstPending === -1) {
      // Every line was already weighed; the bill must have been the thing lost.
      clearStoredCart();
      return;
    }
    setCart(restored);
    setActiveIndex(firstPending);
    setResumed(true);
    // The finished lines are still on the pan, so whatever the scale is reading
    // now becomes the zero the resumed line is measured against.
    tare.zeroAt(getReading());
    stabilityLatch.reset();
    setStage('weighing');
    // Reached once on mount: the item master is still loading, and a second
    // pass would fight an operator who may already have moved on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedItem = items.find((item: Item) => item.id === selectedItemId) ?? null;

  const activeItem = stage !== 'select' ? cart[activeIndex] : null;
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
  // Feed the latch on every settled reading, so a line that has been seen to
  // settle is remembered even if the scale's own flag flickers afterwards.
  useEffect(() => {
    // Judged on the net weight, so stability has to be seen on the same figure
    // the verdict was given on. Otherwise a reading the scale reports as stable
    // while the net weight is still moving would arm the line early.
    stabilityLatch.observe(netWeight, live?.stable === true, status.correct);
  }, [netWeight, live?.stable, status.correct]);
  // A live scale must be settled before a line counts, otherwise a reading
  // that merely swept past the target mid-placement gets accepted. The scale
  // only has to be seen to settle once, though: requiring its stable flag to
  // hold for the whole auto-advance countdown meant an ordinary flicker could
  // restart the countdown and leave a correct line stuck on TARGET REACHED.
  const liveSettled = Boolean(device.connected) && stabilityLatch.hasSettled(netWeight);
  const nextEnabled = status.correct && liveSettled;
  // A correct weight advances on its own, so the operator never has to reach
  // for the button mid-pour. The one place a button is still needed is a line
  // that is at the target but whose scale never reports it settled: a load cell
  // that dithers a gram or two at rest will never produce three byte-identical
  // frames, which would otherwise leave the line wedged with no way forward
  // short of throwing the whole batch away.
  const forceNextEnabled = status.correct && !nextEnabled;
  // Tell the operator the moment a typed target will be snapped, rather than
  // letting the rounded figure appear only on the bill.
  const reqRoundingNote = targetRoundingNote(parseWeight(reqInput) ?? NaN);

  const autoAdvanceMs = useAutoAdvance({
    ready: nextEnabled,
    token: activeItem ? `${activeIndex}:${activeItem.uid}:${activeItem.required}` : null,
    onAdvance: handleNext,
  });

  // The pending bill is kept in storage so a failed save, or a reload while the
  // completion screen is up, can still be retried instead of losing the batch.
  useEffect(() => {
    if (stage === 'complete' && billPayload && !savedBill) savePendingBill(billPayload);
  }, [stage, billPayload, savedBill]);

  useEffect(() => {
    if (savedBill) clearPendingBill();
  }, [savedBill]);

  function selectItem(id: number) {
    setSelectedItemId(id);
    setSelectedFormulaId(null);
    setReqInput('');
    setReqError('');
  }

  function selectFormula(id: number) {
    setSelectedFormulaId(id);
    setSelectedItemId(null);
    setReqInput('');
    setReqError('');
  }

  function loadFormula(formula: Formula) {
    const lines: CartItem[] = formula.lines
      .map((line): CartItem => {
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
    setCart(lines);
    setSelectedFormulaId(null);
    setResumed(false);
    clearStoredCart();
    saveCart(lines, formula.id);
    stopSpeaking();
  }

  function addToCart() {
    const required = parseWeight(reqInput);
    if (required == null || required <= 0) {
      setReqError('Enter a valid weight above zero, e.g. 2.000');
      return;
    }
    // Checked after rounding so a 0.0004 kg target cannot be rounded away into
    // a 0.000 kg line that the server then rejects as an empty weighing.
    if (round3(required) <= 0) {
      setReqError('That weight rounds to zero at 0.001 kg precision. Enter 0.001 or more.');
      return;
    }
    // Snapped to a weight the scale can actually show, so the line is
    // reachable and still moves on by itself when the target lands.
    const target = roundTargetWeight(required);
    // The target is floored to whole kilograms, so anything under a kilogram
    // silently becomes a 1 kg line and anything absurd stays absurd. Both make
    // a line the operator can never complete.
    if (target < 1) {
      setReqError('A line must weigh at least 1 kg. Enter 1.000 or more.');
      return;
    }
    if (target > MAX_TARGET_KG) {
      setReqError(`A line cannot be more than ${MAX_TARGET_KG} kg. Enter a weight up to ${MAX_TARGET_KG} kg.`);
      return;
    }
    if (!selectedItem) return;
    // Build the array once and persist that same array. Persisting `cart`
    // instead would store the list as it was *before* this line, so a reload
    // between here and START WEIGHING would resume one item short and the
    // operator would re-pour from a silently incomplete list.
    const next: CartItem[] = [
      ...cart,
      {
        uid: uid(),
        id: selectedItem.id,
        slug: selectedItem.slug,
        name: selectedItem.name,
        names: selectedItem.names,
        imagePath: selectedItem.imagePath ?? null,
        required: target,
        status: 'pending',
      },
    ];
    setCart(next);
    setReqInput('');
    setReqError('');
    saveCart(next, null);
  }

  function removeFromCart(id: string) {
    setCart((prev) => {
      const next = prev.filter((item) => item.uid !== id);
      saveCart(next, null);
      return next;
    });
  }

  function beginWeighing() {
    if (cart.length === 0) return;
    void api.setPlcOutput(isMaize(cart[0]) ? 'on' : 'off').catch((err) =>
      console.error('PLC output state failed:', err),
    );
    setActiveIndex(0);
    setResumed(false);
    // The uid claim is per attempt. Left set from a previous run it would make
    // handleNext drop the very first line of the next one, and the line would
    // sit on TARGET REACHED forever with no way to move it.
    advancedUidRef.current = null;
    // Whatever the pan is carrying when the batch starts is not part of the
    // batch, so it is zeroed out here instead of being asked for as the first
    // line's weight.
    tare.zeroAt(getReading());
    stabilityLatch.reset();
    saveCart(cart, null);
    setStage('weighing');
  }

  function handleNext(force = false) {
    if (!activeItem) return;
    // A tap on NEXT can land in the same moment the auto-advance timer fires.
    // Both would advance the same line, so the second one is dropped.
    if (advancedUidRef.current === activeItem.uid) return;
    const reading = getReading();
    // The line is judged and recorded on the net weight, which is the item on
    // top of the zero point and not the total the scale is displaying.
    const current = tare.net(reading);
    // The same verdict the operator is looking at. This used to compare the raw
    // reading against the target instead, which is stricter than the screen:
    // a target of 51 kg is accepted on screen from 51.000 up to 51.999, because
    // the reading is rounded down to whole kilograms the way the target is, but
    // the raw comparison only matched 51.000 exactly. A scale sitting anywhere
    // in that kilogram therefore showed WEIGHT ACCEPTED, armed the auto-advance
    // countdown, and then had the advance silently dropped here, so the line
    // never moved on. One source of truth means the two cannot disagree.
    if (current == null || !evaluateReading(activeItem.required, current).correct) return;
    // The forced path is the only way past a scale that never reports its
    // reading as settled, and the operator is still only ever allowed to advance
    // a line the scale actually reads as being at target.
    if (!force && !stabilityLatch.hasSettled(current)) return;
    // Only now is the line really being advanced, so this is the point at which
    // to claim it. Claiming it before the guards passed meant a tap that landed
    // while the scale had not settled burned the line's single attempt and it
    // could never advance afterwards, because every later call saw the uid
    // already taken and returned.
    advancedUidRef.current = activeItem.uid;
    // Record the weight of this item alone, so a bill shows target vs measured
    // for the item and not for the whole batch sitting on the pan.
    const actual = round3(current);
    // Built from the current cart rather than via the updater, because the last
    // line is saved in the same tick and the updater's result is not readable
    // until the next render.
    const completed: CartItem[] = cart.map((item: CartItem, index: number) =>
      index === activeIndex ? { ...item, status: 'completed', actual } : item,
    );
    const nextItem = activeIndex < cart.length - 1 ? cart[activeIndex + 1] : null;
    void api.setPlcOutput(nextItem && isMaize(nextItem) ? 'on' : 'off').catch((err) =>
      console.error('PLC output state failed:', err),
    );
    setCart(completed);
    // Nothing is taken off the scale between lines, so the total now on the pan
    // becomes the zero the next line is measured against. That is what stops the
    // weight just accepted from satisfying the next line: the next line starts
    // from a net of zero, not from the whole batch.
    tare.carry(reading);
    if (activeIndex < cart.length - 1) {
      stabilityLatch.reset();
      setActiveIndex(activeIndex + 1);
      saveCart(completed, null);
    } else {
      completeWeighing(completed);
    }
  }

  function completeWeighing(completed: CartItem[]) {
    const lines = completed.map((item: CartItem) => ({
      itemId: item.id,
      itemName: item.name,
      requiredWeight: item.required,
      // Recorded rounded to whole kilograms, the same figure the operator was
      // shown and the verdict accepted, so the bill agrees with the screen.
      actualWeight: item.actual == null ? null : roundOffWeight(item.actual),
    }));
    const formulaNames = new Set(
      completed
        .map((item: CartItem) => item.formulaName)
        .filter((name): name is string => Boolean(name)),
    );
    const formulaName = formulaNames.size === 1 ? [...formulaNames][0] : null;
    const payload: WeighingPayload = { weighedAt: localIsoNow(), lines, formulaName, ref: uid() };
    setBillPayload(payload);
    setStage('complete');
    setSavedBill(null);
    setBillError('');
    postBill(payload);
  }

  /**
   * Send the finished bill to the server.
   *
   * The payload carries a client generated reference and the server treats a
   * repeat of that reference as the same bill, so pressing RETRY SAVE after a
   * timeout that the server had already committed cannot double count the
   * batch. The synchronous ref guard drops a second POST that somehow reaches
   * here in the same tick.
   */
  function postBill(payload: WeighingPayload) {
    if (savingRef.current) return;
    savingRef.current = true;
    setBillSaving(true);
    api
      .saveWeighing(payload)
      .then((bill: Bill) => {
        setSavedBill(bill);
        // The bill is on the server now, so the cart has nothing left to
        // represent. Leaving it in storage meant a reload after this screen
        // restored the whole formula and the operator weighed it a second time.
        clearStoredCart();
        setBillError('');
      })
      .catch((err) => {
        setBillError(errText(err));
      })
      .finally(() => {
        savingRef.current = false;
        setBillSaving(false);
      });
  }

  function retrySave() {
    if (!billPayload) return;
    setSavedBill(null);
    setBillError('');
    postBill(billPayload);
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
    void api.setPlcOutput('off').catch((err) => console.error('PLC output OFF failed:', err));
    stopSpeaking();
    // The cart is dropped rather than kept. Kept, a restart re-used the same
    // line uids, and lines the operator had already weighed before cancelling
    // were re-posted into the next bill.
    setCart([]);
    setActiveIndex(0);
    advancedUidRef.current = null;
    tare.reset();
    stabilityLatch.reset();
    setSavedBill(null);
    setBillError('');
    setBillPayload(null);
    setResumed(false);
    clearStoredCart();
    clearPendingBill();
    setStage('select');
  }

  function startNewWeighing() {
    // A bill the server never accepted is the only copy of a real, physically
    // poured batch. One habitual tap on the big primary button must not be
    // enough to throw it away without asking.
    if (billPayload && !savedBill) {
      const discard = window.confirm(
        'This weighing was never saved to the records. Starting a new one now discards it for good. Discard it?',
      );
      if (!discard) return;
    }
    stopSpeaking();
    setCart([]);
    setActiveIndex(0);
    advancedUidRef.current = null;
    tare.reset();
    stabilityLatch.reset();
    setSelectedItemId(null);
    setReqInput('');
    setReqError('');
    setSavedBill(null);
    setBillError('');
    setBillPayload(null);
    setResumed(false);
    clearStoredCart();
    clearPendingBill();
    setStage('select');
  }

  function printReport() {
    window.print();
  }

  // No address yet means the Android app is useless, so setup replaces the
  // whole terminal. Once one is stored this is only ever reached to change it,
  // and then it must offer a way back out — the SERVER tab is how the address
  // gets edited, so it opens the edit screen with a CANCEL, not the hard
  // first-run screen.
  if (showServer) {
    const editing = !needsServerAddress();
    return (
      <div className="app">
        <header className="app-header">
          <div className="brand">
            <span className="brand-glyph">⚖</span>
            <span className="brand-text">
              <span className="brand-name">NAVEEN POULTRY FARM</span>
            </span>
          </div>
          <img
            className="app-logo"
            src={`${import.meta.env.BASE_URL}logo.jpeg`}
            alt=""
            width={569}
            height={658}
          />
        </header>
        <main>
          <ServerScreen
            firstRun={!editing}
            onDone={() => setShowServer(false)}
            onCancel={editing ? () => setShowServer(false) : undefined}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header header-weighing">
        <div className="brand">
          <span className="brand-glyph">⚖</span>
          <span className="brand-text">
            <span className="brand-name">NAVEEN POULTRY FARM</span>
          </span>
        </div>
        <div className="header-controls">
          <FontSizeControl />
          {isNativeApp() && serverOrigin && (
            <button
              type="button"
              className="btn btn-secondary btn-sm server-chip"
              onClick={() => setShowServer(true)}
              title="Change the weighing server this app uses"
            >
              {serverOrigin.replace(/^https?:\/\//, '')}
            </button>
          )}
          <ScaleSettings state={scaleLinkState} label={scaleLinkLabel}>
            <ScaleConnection
              device={device}
              port={port}
              ports={ports}
              baudRates={baudRates}
              deviceBusy={deviceBusy}
              deviceError={deviceError}
              refresh={refreshScaleInfo}
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

      <nav className="nav-tabs">
        {SCREENS.map((entry: { key: ScreenKey; label: string }) => (
          <button
            key={entry.key}
            type="button"
            className={`nav-tab${screen === entry.key ? ' active' : ''}`}
            onClick={() => setScreen(entry.key)}
          >
            {entry.label}
          </button>
        ))}
        {isNativeApp() && serverOrigin && (
          <button
            type="button"
            className="nav-tab server-tab"
            onClick={() => setShowServer(true)}
          >
            SERVER
          </button>
        )}
      </nav>

      <main>
        {isNativeApp() && showServer && !needsServerAddress() && (
          <div className="panel server-edit-bar">
            <ServerScreen
              firstRun={false}
              onDone={() => setShowServer(false)}
              onCancel={() => setShowServer(false)}
            />
          </div>
        )}
        {itemsError && screen === 'weighing' && (
          <div className="error-banner">
            Item master unavailable: {itemsError}{' '}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => loadItems()}>
              RETRY
            </button>
          </div>
        )}

        {formulasError && screen === 'weighing' && (
          <div className="error-banner">
            Formula catalog unavailable: {formulasError}{' '}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => loadFormulas()}>
              RETRY
            </button>
          </div>
        )}

        {screen === 'weighing' && (
          <>
            {stage === 'select' && (
              <ItemSelection
                items={items}
                itemsLoading={itemsLoading}
                formulas={formulas}
                cart={cart}
                selectedItemId={selectedItemId}
                selectedFormulaId={selectedFormulaId}
                reqInput={reqInput}
                roundingNote={reqRoundingNote}
                reqError={reqError}
                onSelectItem={selectItem}
                onSelectFormula={selectFormula}
                onReqInput={setReqInput}
                onAddToCart={addToCart}
                onRemove={removeFromCart}
                onStart={beginWeighing}
                onLoadFormula={loadFormula}
              />
            )}

            {resumed && stage === 'weighing' && (
              <div className="error-banner resume-banner">
                This weighing was restored after the app reloaded. Lines already
                weighed are marked complete; check the queue before continuing.{' '}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={cancelWeighing}
                >
                  DISCARD
                </button>
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
                forceNextEnabled={forceNextEnabled}
                nextBlockedReason={
                  loadRemoved
                    ? 'Material came off the scale. Clear the pan and press ZERO HERE, or put the weight back on.'
                    : status.correct && !liveSettled
                      ? 'The scale has not reported this reading as settled yet. It may never do so — use NEXT LINE to move on.'
                      : null
                }
                voiceLang={voiceLang}
                device={device}
                live={live}
                onNext={handleNext}
                onZero={() => tare.zeroAt(getReading())}
                onCancel={cancelWeighing}
              />
            )}

            {stage === 'complete' && (
              <CompletionScreen
                cart={cart}
                savedBill={savedBill}
                saving={billSaving}
                saveError={billError}
                onStartNew={startNewWeighing}
                onPrint={printReport}
                onViewHistory={() => setScreen('history')}
                onRetry={retrySave}
              />
            )}
          </>
        )}

        {screen === 'items' && (
          <ItemsScreen
            items={items}
            itemsLoading={itemsLoading}
            itemsError={itemsError}
            onItemsChanged={() => {
              loadItems();
              loadFormulas();
            }}
          />
        )}

        {screen === 'formulas' && (
          <FormulasScreen
            items={items}
            formulas={formulas}
            formulasError={formulasError}
            onFormulasChanged={loadFormulas}
          />
        )}

        {screen === 'history' && <HistoryScreen />}

        {screen === 'reports' && <ReportsScreen />}
      </main>

      <footer className="app-footer no-print">© Copyright Reem Engineering Enterprises</footer>
    </div>
  );
}