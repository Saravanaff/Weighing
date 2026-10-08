import { fmtWeight } from '../lib/weights.ts';
import type { CartItem, Formula, Item } from '../lib/types.ts';

export interface ItemSelectionProps {
  items: Item[];
  itemsLoading: boolean;
  formulas: Formula[];
  cart: CartItem[];
  selectedItemId: number | null;
  selectedFormulaId: number | null;
  reqInput: string;
  /** What the typed target will be snapped to, when it differs. */
  roundingNote?: string | null;
  reqError: string;
  onSelectItem: (id: number) => void;
  onSelectFormula: (id: number) => void;
  onReqInput: (value: string) => void;
  onAddToCart: () => void;
  onRemove: (uid: string) => void;
  onStart: () => void;
  onLoadFormula: (formula: Formula) => void;
}

export function ItemSelection({
  items,
  itemsLoading,
  formulas,
  cart,
  selectedItemId,
  selectedFormulaId,
  reqInput,
  roundingNote,
  reqError,
  onSelectItem,
  onSelectFormula,
  onReqInput,
  onAddToCart,
  onRemove,
  onStart,
  onLoadFormula,
}: ItemSelectionProps) {
  const selectedItem = items.find((item: Item) => item.id === selectedItemId);
  const selectedFormula = formulas.find((formula: Formula) => formula.id === selectedFormulaId);
  const cartTotal = cart.reduce((sum, item) => sum + item.required, 0);

  const selectItem = (id: number) => {
    onSelectItem(id);
    onReqInput('');
  };
  const selectFormula = (formula: Formula) => {
    onSelectFormula(formula.id);
    onReqInput('');
  };

  const formulaContent = selectedFormula && (
    <div className="select-form">
      <div className="formula-summary">
        <div className="formula-summary-name">{selectedFormula.name}</div>
        <div className="formula-summary-meta">
          {selectedFormula.lines.length} items · {fmtWeight(selectedFormula.totalWeight)}
        </div>
      </div>
      <div className="formula-builder-list">
        {selectedFormula.lines.map((line, index: number) => (
          <div key={`${line.itemId}-${index}`} className="formula-builder-row">
            <span className="formula-builder-name">{line.itemName}</span>
            <span className="num formula-builder-weight">{fmtWeight(line.requiredWeight)}</span>
          </div>
        ))}
      </div>
      <div className="formula-master-note">
        Using this formula replaces the current weighing list with its items.
      </div>
      <button
        type="button"
        className="btn btn-primary btn-block"
        onClick={() => onLoadFormula(selectedFormula)}
      >
        LOAD FORMULA INTO WEIGHING LIST
      </button>
    </div>
  );

  const itemContent = selectedItem && (
    <div className="select-form">
      <div className="form-field">
        <div className="field-label">Item Name</div>
        <div className="selected-name">{selectedItem.name}</div>
      </div>
      <div className="form-field">
        <div className="field-label">Required Weight</div>
        <div className="input-row">
          <input
            id="req-weight"
            className="weight-input"
            type="number"
            step="0.001"
            min="0"
            placeholder="0.000"
            inputMode="decimal"
            value={reqInput}
            onChange={(event) => onReqInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onAddToCart();
            }}
          />
          <span className="unit">kg</span>
        </div>
        {reqError && <div className="error-text">{reqError}</div>}
        {/* Shown while typing, so the snapped target is never a surprise on
            the bill. */}
        {!reqError && roundingNote && <div className="metric-hint">{roundingNote}</div>}
      </div>
      <button type="button" className="btn btn-primary btn-block" onClick={onAddToCart}>
        ADD TO WEIGHING LIST
      </button>
    </div>
  );

  return (
    <section className="stage stage-with-action-bar">
      <div className="selection-layout">
        <div className="left-rail">
          <div className="panel">
            <div className="panel-title">FORMULA CATALOG</div>
            <div className="panel-sub">Load a pre-set combination</div>
            <div className="item-list">
              {formulas.length === 0 ? (
                <div className="panel-placeholder">
                  No formulas yet. Create them under the FORMULAS tab.
                </div>
              ) : (
                formulas.map((formula: Formula) => (
                  <button
                    key={formula.id}
                    type="button"
                    className={`item-row${selectedFormulaId === formula.id ? ' selected' : ''}`}
                    onClick={() => selectFormula(formula)}
                  >
                    <span className="item-name">{formula.name}</span>
                    <span className="item-code">{formula.lines.length} ing.</span>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">ITEM MASTER</div>
            <div className="panel-sub">Select single items to be weighed</div>
            <div className="item-list">
              {itemsLoading ? (
                <div className="panel-placeholder">Loading items…</div>
              ) : items.length === 0 ? (
                <div className="panel-placeholder">
                  No items in the master. Add items under ITEM MASTER.
                </div>
              ) : (
                items.map((item: Item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`item-row${selectedItemId === item.id ? ' selected' : ''}`}
                    onClick={() => selectItem(item.id)}
                  >
                    <span className="item-code">{item.code}</span>
                    <span className="item-name">{item.name}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            {selectedFormula ? 'SELECTED FORMULA' : 'SELECT ITEM'}
          </div>
          {selectedFormula
            ? formulaContent
            : selectedItem
              ? itemContent
              : (
                <div className="panel-placeholder">
                  Pick a formula from the catalog or an item from the master to begin building the
                  weighing list.
                </div>
              )}
        </div>

        <div className="panel weighing-list">
          <div className="panel-title">WEIGHING LIST</div>
          <div className="panel-sub">Items queued for the weighing terminal</div>
          {cart.length === 0 ? (
            <div className="panel-placeholder">No items in the weighing list.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th className="col-no">No.</th>
                  <th>Item</th>
                  <th className="col-w">Required Weight</th>
                  <th className="col-status">Status</th>
                  <th className="col-x" />
                </tr>
              </thead>
              <tbody>
                {cart.map((item: CartItem, index: number) => (
                  <tr key={item.uid}>
                    <td className="num col-no">{String(index + 1).padStart(2, '0')}</td>
                    <td>
                      {item.name}
                      {item.formulaName && (
                        <div className="cart-formula-tag">{item.formulaName}</div>
                      )}
                    </td>
                    <td className="num col-w">{fmtWeight(item.required)}</td>
                    <td className="col-status">
                      <span className={`chip chip-${item.status}`}>
                        {item.status === 'completed' ? 'Complete' : 'Pending'}
                      </span>
                    </td>
                    <td className="col-x">
                      <button type="button" className="remove-btn" onClick={() => onRemove(item.uid)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="panel-footer weighing-list-footer">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              disabled={cart.length === 0}
              onClick={onStart}
            >
              START WEIGHING
            </button>
          </div>
        </div>
      </div>

      {/*
        On a phone the three panels stack, so this button used to sit at the
        very bottom of a page more than two screens tall — past the whole item
        master — and the operator had to scroll every time to start a batch.
        This bar is pinned to the bottom of the viewport instead and carries
        the running count and total, so the list can be checked at a glance
        without scrolling. CSS hides it on desktop, where the panel footer
        above is already visible and the page fits.
      */}
      <div className="select-action-bar" role="group" aria-label="Start weighing">
        <div className="select-action-summary">
          <span className="select-action-count">
            {cart.length} {cart.length === 1 ? 'item' : 'items'}
          </span>
          <span className="select-action-total">{fmtWeight(cartTotal)}</span>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-lg"
          disabled={cart.length === 0}
          onClick={onStart}
        >
          START WEIGHING
        </button>
      </div>
    </section>
  );
}