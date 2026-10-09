import { STAGES, STAGE_LABELS, type AnalysisMode, type PipelineEvent, type Stage } from '@claimlens/shared';

type StepState = 'pending' | 'running' | 'done';

function stateOf(stage: Stage, events: PipelineEvent[]): StepState {
  let state: StepState = 'pending';
  for (const e of events) {
    if (e.type === 'stage' && e.stage === stage) state = e.status;
  }
  return state;
}

export function PipelineProgress({ events, mode }: { events: PipelineEvent[]; mode: AnalysisMode | null }) {
  const states = STAGES.map((stage) => ({ stage, state: stateOf(stage, events) }));
  const current = states.find((s) => s.state === 'running');
  const doneCount = states.filter((s) => s.state === 'done').length;

  return (
    <section className="card progress-card">
      <h1>Running AI analysis pipeline</h1>
      {mode === 'demo' && <p className="muted">Demo mode: results are simulated.</p>}
      <div
        className="progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={STAGES.length}
        aria-valuenow={doneCount}
        aria-label="Pipeline progress"
      >
        <div className="progress-bar-fill" style={{ width: `${(doneCount / STAGES.length) * 100}%` }} />
      </div>
      <ol className="steps">
        {states.map(({ stage, state }) => (
          <li key={stage} className={`step step-${state}`}>
            <span className="step-mark" aria-hidden="true">{state === 'done' ? '✓' : ''}</span>
            <span>{STAGE_LABELS[stage]}</span>
            <span className="visually-hidden">
              {state === 'done' ? ' (done)' : state === 'running' ? ' (in progress)' : ' (waiting)'}
            </span>
          </li>
        ))}
      </ol>
      <p className="visually-hidden" aria-live="polite">
        {current ? STAGE_LABELS[current.stage] : ''}
      </p>
    </section>
  );
}
