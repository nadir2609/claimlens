import type { AnalysisMode, ClaimReport, ClaimStatus, ClaimSummary, PipelineEvent, QualityResult } from '@claimlens/shared';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly photos?: { filename: string; quality: QualityResult }[]) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check that it is running.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`, body?.photos);
  return body as T;
}

const form = (files: File[]) => {
  const data = new FormData();
  for (const f of files) data.append('photos', f);
  return data;
};
const json = (method: string, body: unknown): RequestInit =>
  ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  getConfig: () => call<{ analysisMode: AnalysisMode }>('/api/config'),
  createClaim: (files: File[]) => call<{ id: string }>('/api/claims', { method: 'POST', body: form(files) }),
  addPhotos: (id: string, files: File[]) => call<{ id: string }>(`/api/claims/${id}/photos`, { method: 'POST', body: form(files) }),
  retryClaim: (id: string) => call<{ id: string }>(`/api/claims/${id}/retry`, { method: 'POST' }).then(() => undefined),
  getClaim: (id: string) => call<ClaimReport>(`/api/claims/${id}`),
  listClaims: () => call<ClaimSummary[]>('/api/claims'),
  setStatus: (id: string, status: ClaimStatus) => call<ClaimReport>(`/api/claims/${id}`, json('PATCH', { status })),

  /** Streams pipeline progress. If the stream drops, reports the stored outcome instead. */
  watchClaim(id: string, onEvent: (e: PipelineEvent) => void): () => void {
    const source = new EventSource(`/api/claims/${id}/events`);
    let finished = false;
    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as PipelineEvent;
      if (event.type !== 'stage') { finished = true; source.close(); }
      onEvent(event);
    };
    source.onerror = () => {
      if (finished) return;
      source.close();
      api.getClaim(id).then(
        (r) => onEvent(r.state === 'done' ? { type: 'done' } : { type: 'failed', error: r.error ?? 'Lost connection during analysis.' }),
        () => onEvent({ type: 'failed', error: 'Lost connection during analysis.' }),
      );
    };
    return () => { finished = true; source.close(); };
  },
};
