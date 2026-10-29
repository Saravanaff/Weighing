import './batchPrompt.css';

export interface BatchContinuePromptProps {
  formulaName: string;
  batchNumber: number;
  totalBatches: number;
  saving?: boolean;
  error?: string;
  onContinue: () => void;
  onStop: () => void;
}

/**
 * Shown when one batch of a multi-batch weighing is finished. The completed
 * batch is already on its way to the server, so the operator decides whether to
 * arm the next batch or stop after this one.
 */
export function BatchContinuePrompt({
  formulaName,
  batchNumber,
  totalBatches,
  saving = false,
  error = '',
  onContinue,
  onStop,
}: BatchContinuePromptProps) {
  const next = batchNumber + 1;
  return (
    <div
      className="batch-prompt-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Continue to next batch"
    >
      <div className="batch-prompt">
        <div className="batch-prompt-title">
          Batch {batchNumber} of {totalBatches} Complete
        </div>
        <div className="batch-prompt-formula">{formulaName}</div>
        <p className="batch-prompt-label">
          Continue with batch {next} of {totalBatches}?
        </p>
        {error && (
          <div className="batch-prompt-error" role="alert">
            {error}
          </div>
        )}
        <div className="batch-prompt-actions">
          <button type="button" className="btn btn-secondary" onClick={onStop} disabled={saving}>
            STOP HERE
          </button>
          <button type="button" className="btn btn-primary" onClick={onContinue} disabled={saving}>
            {saving ? 'SAVING…' : `CONTINUE BATCH ${next}`}
          </button>
        </div>
      </div>
    </div>
  );
}
