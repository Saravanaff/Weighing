import { useEffect, useRef, useState } from 'react';
import './batchPrompt.css';

export interface BatchPromptProps {
  formulaName: string;
  onConfirm: (count: number) => void;
  onCancel: () => void;
}

export function BatchPrompt({ formulaName, onConfirm, onCancel }: BatchPromptProps) {
  const [value, setValue] = useState('1');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const count = Math.max(1, parseInt(value, 10) || 1);
  const confirm = () => onConfirm(count);

  return (
    <div className="batch-prompt-overlay" role="dialog" aria-modal="true" aria-label="Number of Batches">
      <div className="batch-prompt">
        <div className="batch-prompt-title">Number of Batches</div>
        <div className="batch-prompt-formula">{formulaName}</div>
        <label className="batch-prompt-label" htmlFor="batch-count">
          How many times should this formula be weighed?
        </label>
        <input
          id="batch-count"
          ref={inputRef}
          className="batch-prompt-input"
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') confirm();
            if (event.key === 'Escape') onCancel();
          }}
        />
        <div className="batch-prompt-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            CANCEL
          </button>
          <button type="button" className="btn btn-primary" onClick={confirm}>
            START WEIGHING
          </button>
        </div>
      </div>
    </div>
  );
}
