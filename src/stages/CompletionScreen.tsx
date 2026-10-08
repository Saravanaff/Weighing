import { fmtDateTime, fmtWeight } from '../lib/weights.ts';
import type { Bill, CartItem } from '../lib/types.ts';

export interface CompletionScreenProps {
  cart: CartItem[];
  savedBill: Bill | null;
  saving: boolean;
  saveError: string;
  onStartNew: () => void;
  onPrint: () => void;
  onViewHistory?: () => void;
  onRetry?: () => void;
}

export function CompletionScreen({
  cart,
  savedBill,
  saving,
  saveError,
  onStartNew,
  onPrint,
  onViewHistory,
  onRetry,
}: CompletionScreenProps) {
  const batchLabel = savedBill
    ? savedBill.batchNo
    : saving
      ? 'SAVING RECORD…'
      : `WEIGH-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  const formulaNames = new Set(
    cart.map((item: CartItem) => item.formulaName).filter((name): name is string => Boolean(name)),
  );
  const formulaLabel = formulaNames.size === 1 ? [...formulaNames][0] : null;

  return (
    <section className="stage">
      <div className="completion-wrap">
        <div className="panel print-area">
          <div className="completion-head">
            <div className="completion-title">WEIGHING COMPLETE</div>
            <div className="completion-sub">
              Batch: {batchLabel}
              {savedBill ? ` · Recorded ${fmtDateTime(savedBill.weighedAt)}` : ''}
            </div>
            {formulaLabel && (
              <div className="formula-label">Formula: {formulaLabel}</div>
            )}
            {(saving || saveError) && (
              <div className={`save-state ${saveError ? 'save-error' : 'save-saved'}`}>
                {saveError
                  ? `Not stored: ${saveError} `
                  : 'Storing this weighing in the records…'}
                {saveError && onRetry && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
                    RETRY SAVE
                  </button>
                )}
              </div>
            )}
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th className="col-no">No.</th>
                <th>Item</th>
                <th className="col-w">Target Weight</th>
                <th className="col-w">Weighed</th>
                <th className="col-status">Status</th>
              </tr>
            </thead>
            <tbody>
              {cart.map((item: CartItem, index: number) => {
                const measured = item.actual == null ? null : item.actual;
                const drift =
                  measured == null ? null : Math.round((measured - item.required) * 1000) / 1000;
                return (
                <tr key={item.uid}>
                  <td className="num col-no">{String(index + 1).padStart(2, '0')}</td>
                  <td>{item.name}</td>
                  <td className="num col-w">{fmtWeight(item.required)}</td>
                  <td className="num col-w">
                    {measured == null ? (
                      <span className="muted">—</span>
                    ) : (
                      <>
                        {fmtWeight(measured)}
                        {drift != null && drift !== 0 && (
                          <span className={`drift ${drift > 0 ? 'over' : 'under'}`}>
                            {' '}
                            {drift > 0 ? '+' : ''}
                            {drift.toFixed(3)}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="col-status">
                    <span className="chip chip-accepted">✓ Accepted</span>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>

          <div className="completion-total">
            <span>Total Items: {cart.length}</span>
            <span>
              Total Weight:{' '}
              <b>{fmtWeight(cart.reduce((sum, item) => sum + item.required, 0))}</b>
            </span>
          </div>
        </div>

        <div className="completion-actions no-print">
          <button type="button" className="btn btn-secondary" onClick={onPrint}>
            PRINT REPORT
          </button>
          {onViewHistory && (
            <button type="button" className="btn btn-secondary" onClick={onViewHistory}>
              VIEW HISTORY
            </button>
          )}
          <button type="button" className="btn btn-primary btn-lg" onClick={onStartNew}>
            START NEW WEIGHING
          </button>
        </div>
      </div>
    </section>
  );
}