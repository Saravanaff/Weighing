import { useState } from 'react';
import { api } from '../api.ts';
import { fmtWeight } from '../lib/weights.ts';
import type { Formula, Item, WeighingLine } from '../lib/types.ts';
import { roundTargetWeight, targetRoundingNote } from '../../shared/targetWeight.ts';

const MAX_NAME_LENGTH = 60;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface FormulasScreenProps {
  items: Item[];
  formulas: Formula[];
  formulasError: string;
  onFormulasChanged: () => void | Promise<void>;
}

export function FormulasScreen({
  items,
  formulas,
  formulasError,
  onFormulasChanged,
}: FormulasScreenProps) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [lines, setLines] = useState<WeighingLine[]>([]);
  const [selItemId, setSelItemId] = useState('');
  const [ingWeight, setIngWeight] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  const itemById = (id: string | number) => items.find((item: Item) => item.id === Number(id));

  function resetForm() {
    setEditingId(null);
    setName('');
    setLines([]);
    setSelItemId('');
    setIngWeight('');
    setError('');
    setConfirmingId(null);
  }

  function startEdit(formula: Formula) {
    setEditingId(formula.id);
    setName(formula.name);
    setLines(
      formula.lines.map((line) => ({
        itemId: line.itemId,
        itemName: line.itemName,
        requiredWeight: line.requiredWeight,
      })),
    );
    setSelItemId('');
    setIngWeight('');
    setError('');
    setConfirmingId(null);
  }

  function addIngredient() {
    const item = itemById(selItemId);
    const weight = Number(ingWeight);
    if (!item) {
      setError('Select an item from the list first');
      return;
    }
    if (!Number.isFinite(weight) || weight <= 0) {
      setError('Enter a weight above zero, e.g. 0.250');
      return;
    }
    if (lines.some((line) => line.itemId === item.id)) {
      setError(`${item.name} is already in this formula`);
      return;
    }
    setLines((prev) => [
      ...prev,
      // Snapped to a weight the scale can show, so the line is reachable.
      { itemId: item.id, itemName: item.name, requiredWeight: roundTargetWeight(weight) },
    ]);
    setSelItemId('');
    setIngWeight('');
    setError('');
  }

  function removeIngredient(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function saveFormula() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Formula name is required');
      return;
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      setError(`Formula name must be ${MAX_NAME_LENGTH} characters or fewer`);
      return;
    }
    if (lines.length === 0) {
      setError('Add at least one item to the formula');
      return;
    }
    setSaving(true);
    setError('');
    const payload = {
      name: trimmed,
      lines: lines.map((line: WeighingLine) => ({
        itemId: line.itemId,
        requiredWeight: line.requiredWeight,
      })),
    };
    try {
      if (editingId != null) {
        await api.updateFormula(editingId, payload);
      } else {
        await api.createFormula(payload);
      }
      resetForm();
      onFormulasChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(formula: Formula) {
    if (confirmingId !== formula.id) {
      setConfirmingId(formula.id);
      window.setTimeout(() => {
        setConfirmingId((current) => (current === formula.id ? null : current));
      }, 3000);
      return;
    }
    setConfirmingId(null);
    try {
      await api.deleteFormula(formula.id);
      if (editingId === formula.id) resetForm();
      onFormulasChanged();
    } catch (err) {
      setError(errText(err));
    }
  }

  const totalWeight = lines.reduce((sum, line) => sum + line.requiredWeight, 0);
  const ingRoundingNote = targetRoundingNote(Number(ingWeight));

  return (
    <section className="stage">
      <div className="screen-title">
        {editingId != null ? `EDIT FORMULA` : 'FORMULAS'}
      </div>
      <div className="screen-sub">
        A formula is a pre-set combination of items with their exact weighing targets.
        Load a formula at the weighing terminal to start weighing it immediately.
      </div>

      {error && <div className="error-banner">{error}</div>}
      {formulasError && (
        <div className="error-banner">
          Could not load formulas: {formulasError}{' '}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onFormulasChanged}>
            RETRY
          </button>
        </div>
      )}

      <div className="items-layout">
        <div className="panel items-form-panel">
          <div className="panel-title">
            {editingId != null ? 'EDITING FORMULA' : 'ADD FORMULA'}
          </div>
          <div className="items-form">
            <div className="form-grid">
              <div className="form-field">
                <div className="field-label">Formula Name *</div>
                <input
                  className="text-input"
                  type="text"
                  placeholder="e.g. Layer 1"
                  maxLength={MAX_NAME_LENGTH}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>

              <div className="form-field">
                <div className="field-label">Add Item</div>
                <div className="ing-row">
                  <select
                    className="select-input"
                    value={selItemId}
                    onChange={(event) => setSelItemId(event.target.value)}
                  >
                    <option value="">Select item…</option>
                    {items.map((item: Item) => (
                      <option key={item.id} value={item.id}>
                        {item.code} — {item.name}
                      </option>
                    ))}
                  </select>
                  <div className="input-row">
                    <input
                      className="weight-input ing-weight"
                      type="number"
                      step="0.001"
                      min="0"
                      placeholder="0.000"
                      inputMode="decimal"
                      value={ingWeight}
                      onChange={(event) => setIngWeight(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') addIngredient();
                      }}
                    />
                    <span className="unit">kg</span>
                  </div>
                  <button type="button" className="btn btn-secondary" onClick={addIngredient}>
                    ADD
                  </button>
                </div>
                {/* Shown while typing, so the snapped weight is never a
                    surprise once the line is on the formula. */}
                {ingRoundingNote && <div className="metric-hint">{ingRoundingNote}</div>}
              </div>
            </div>

            {lines.length === 0 ? (
              <div className="panel-placeholder">No items in this formula yet.</div>
            ) : (
              <div className="formula-builder-list">
                {lines.map((line: WeighingLine, index: number) => (
                  <div key={`${line.itemId}-${index}`} className="formula-builder-row">
                    <span className="formula-builder-name">{line.itemName}</span>
                    <span className="num formula-builder-weight">{fmtWeight(line.requiredWeight)}</span>
                    <button
                      type="button"
                      className="remove-btn"
                      onClick={() => removeIngredient(index)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <div className="formula-builder-total">
                  <span>No. of Ingredients: {lines.length}</span>
                  <span className="num">Total: {fmtWeight(totalWeight)}</span>
                </div>
              </div>
            )}

            <div className="items-form-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving}
                onClick={saveFormula}
              >
                {saving ? 'SAVING…' : editingId != null ? 'SAVE CHANGES' : 'CREATE FORMULA'}
              </button>
              {editingId != null && (
                <button type="button" className="btn btn-secondary" onClick={resetForm}>
                  CANCEL
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="panel items-list-panel">
          <div className="panel-title">FORMULA CATALOG ({formulas.length})</div>
          {formulas.length === 0 ? (
            <div className="panel-placeholder">
              No formulas yet. Create one with the form — e.g. Layer 1 with Wheat Bran, Maize, Limestone.
            </div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Formula</th>
                    <th>No. of Ingredients</th>
                    <th className="text-right">Total Weight</th>
                    <th className="col-x" />
                  </tr>
                </thead>
                <tbody>
                  {formulas.map((formula: Formula) => (
                    <tr key={formula.id}>
                      <td>
                        <div className="formula-name">{formula.name}</div>
                        <div className="formula-lines">
                          {formula.lines.map((line, index: number) => (
                            // Saved lines carry an id; a formula still being
                            // built does not, so fall back to the position.
                            <span key={line.id ?? `${line.itemId}-${index}`} className="formula-line-chip">
                              {line.itemName} {fmtWeight(line.requiredWeight)}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td data-label="No. of Ingredients" className="num">{formula.itemCount}</td>
                      <td data-label="Total Weight" className="num text-right">{fmtWeight(formula.totalWeight)}</td>
                      <td className="col-x">
                        <div className="formula-actions">
                          <button
                            type="button"
                            className="delete-btn"
                            onClick={() => startEdit(formula)}
                          >
                            EDIT
                          </button>
                          <button
                            type="button"
                            className={`delete-btn${confirmingId === formula.id ? ' confirming' : ''}`}
                            onClick={() => handleDelete(formula)}
                          >
                            {confirmingId === formula.id ? 'CONFIRM?' : 'DELETE'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}