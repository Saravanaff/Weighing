import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { fmtDateTime, fmtWeight } from '../lib/weights.ts';
import type { Bill, BillDetail } from '../lib/types.ts';

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function HistoryScreen() {
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<BillDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  // Tapping through rows faster than the network answers used to leave the
  // previous bill's lines under the newly opened row, and set loading false
  // while a fetch was still in flight. Only the newest request may write.
  const listSeq = useRef(0);
  const detailSeq = useRef(0);

  async function load() {
    const seq = ++listSeq.current;
    setLoading(true);
    setError('');
    try {
      const list = await api.getWeighings();
      if (seq !== listSeq.current) return;
      setBills(Array.isArray(list) ? list : []);
    } catch (err) {
      if (seq !== listSeq.current) return;
      setError(errText(err));
    } finally {
      if (seq === listSeq.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    return () => {
      // Any in-flight response is now irrelevant.
      listSeq.current += 1;
      detailSeq.current += 1;
    };
  }, []);

  async function loadDetail(id: number) {
    const seq = ++detailSeq.current;
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    try {
      const next = await api.getWeighing(id);
      if (seq !== detailSeq.current) return;
      setDetail(next);
    } catch (err) {
      if (seq !== detailSeq.current) return;
      setDetailError(errText(err));
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }

  function toggle(id: number) {
    if (openId === id) {
      // Invalidate the pending fetch so it cannot reopen the row on resolve.
      detailSeq.current += 1;
      setOpenId(null);
      setDetail(null);
      setDetailError('');
      setDetailLoading(false);
      return;
    }
    setOpenId(id);
    void loadDetail(id);
  }

  const renderRows = () => {
    if (bills.length === 0) {
      return (
        <div className="panel-placeholder">
          No weighing records yet. Complete a weighing from the terminal to store it here.
        </div>
      );
    }
    return (
      <div className="history-list">
        {bills.map((bill: Bill) => {
          const opened = openId === bill.id;
          return (
            <div key={bill.id} className={`history-row${opened ? ' open' : ''}`}>
              <button
                type="button"
                className="history-head"
                onClick={() => toggle(bill.id)}
              >
                <span className="num batch-no">{bill.batchNo}</span>
                <span className="history-date">{fmtDateTime(bill.weighedAt)}</span>
                <span className="history-formula">
                  {bill.formulaName ? (
                    <span className="formula-name-chip">{bill.formulaName}</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </span>
                <span className="num history-items">{bill.itemCount} items</span>
                <span className="num history-weight">{fmtWeight(bill.totalWeight)}</span>
                <span className="history-expand">{opened ? '−' : '+'}</span>
              </button>
              {opened && (
                <div className="history-detail">
                  {detailLoading && <div className="panel-placeholder">Loading details…</div>}
                  {detailError && (
                    <div className="error-text">
                      {detailError}{' '}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => void loadDetail(bill.id)}
                      >
                        RETRY
                      </button>
                    </div>
                  )}
                  {detail && (
                    <>
                      {detail.formulaName && (
                        <div className="history-detail-formula">
                          Formula: <b>{detail.formulaName}</b>
                        </div>
                      )}
                      <table className="data-table">
                      <thead>
                        <tr>
                          <th className="col-no">No.</th>
                          <th>Item</th>
                          <th className="col-w">Target</th>
                          <th className="col-w">Weighed</th>
                          <th className="col-status">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(detail.lines ?? []).map((line, index: number) => {
                          // Bills saved before measured weights were recorded
                          // have no actual value, so show the target and say so
                          // rather than printing a misleading zero.
                          const measured =
                            line.actualWeight == null ? null : Math.round(line.actualWeight * 1000) / 1000;
                          const drift =
                            measured == null ? null : Math.round((measured - line.requiredWeight) * 1000) / 1000;
                          return (
                          <tr key={line.id}>
                            <td className="num col-no">{String(index + 1).padStart(2, '0')}</td>
                            <td>{line.itemName}</td>
                            <td className="num col-w">{fmtWeight(line.requiredWeight)}</td>
                            <td className="num col-w">
                              {measured == null ? (
                                <span className="muted">not recorded</span>
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
                              <span className="chip chip-accepted">
                                {measured == null ? 'Accepted' : 'Accepted ✓'}
                              </span>
                            </td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <section className="stage">
      <div className="screen-title">
        WEIGHING HISTORY
        <button type="button" className="btn btn-secondary refresh-btn" onClick={load}>
          REFRESH
        </button>
      </div>
      <div className="screen-sub">All stored bills, newest first. Click a batch to view its line items.</div>

      {error && (
        <div className="error-banner">
          Could not load history: {error}{' '}
          <button type="button" className="btn btn-secondary btn-sm" onClick={load}>
            RETRY
          </button>
        </div>
      )}

      <div className="panel">
        <div className="panel-title">STORED BILLS ({bills.length})</div>
        {loading ? <div className="panel-placeholder">Loading records…</div> : renderRows()}
      </div>
    </section>
  );
}