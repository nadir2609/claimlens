import { DropZone } from './DropZone';

interface Props {
  prompts: string[];
  canAdd: boolean;
  busy: boolean;
  error: string | null;
  onAdd(files: File[]): void;
  onContinue(): void;
}

export function CoveragePrompt({ prompts, canAdd, busy, error, onAdd, onContinue }: Props) {
  return (
    <section className="card">
      <h1>More photos needed</h1>
      <p>The analysis finished, but some views or parts of the vehicle could not be inspected:</p>
      <ul className="prompt-list">
        {prompts.map((p) => <li key={p}>{p}</li>)}
      </ul>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {canAdd ? (
        <DropZone compact disabled={busy} onFiles={onAdd} label="Add photos and re-run" />
      ) : (
        <p className="muted">This claim already has the maximum of 10 photos.</p>
      )}
      <div className="row-actions">
        <button type="button" className="btn" onClick={onContinue} disabled={busy}>
          Continue to report
        </button>
        <span className="muted small">
          Parts not shown will be marked Not inspected and the claim will go to manual review.
        </span>
      </div>
    </section>
  );
}
