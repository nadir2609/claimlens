import type { PipelineEvent } from '@claimlens/shared';

type Listener = (event: PipelineEvent) => void;

/** In-memory progress events per claim. History is kept so late subscribers see the whole run. */
export class EventBus {
  private runs = new Map<string, { history: PipelineEvent[]; listeners: Set<Listener> }>();

  start(id: string): void {
    const existing = this.runs.get(id);
    this.runs.set(id, { history: [], listeners: existing?.listeners ?? new Set() });
  }

  emit(id: string, event: PipelineEvent): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.history.push(event);
    for (const listener of [...run.listeners]) listener(event);
  }

  subscribe(id: string, listener: Listener): () => void {
    let run = this.runs.get(id);
    if (!run) { run = { history: [], listeners: new Set() }; this.runs.set(id, run); }
    for (const event of run.history) listener(event);
    run.listeners.add(listener);
    return () => { this.runs.get(id)?.listeners.delete(listener); };
  }

  hasRun(id: string): boolean {
    return (this.runs.get(id)?.history.length ?? 0) > 0;
  }
}
