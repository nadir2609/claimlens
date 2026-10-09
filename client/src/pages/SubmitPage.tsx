import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ClaimReport, PipelineEvent } from '@claimlens/shared';
import { ApiError, api } from '../api';
import { useAnalysisMode } from '../App';
import { CoveragePrompt } from '../components/CoveragePrompt';
import { DropZone } from '../components/DropZone';
import { PhotoCard, type PhotoItem } from '../components/PhotoCard';
import { PipelineProgress } from '../components/PipelineProgress';
import { checkImageQuality } from '../lib/imageQuality';

const MIN = 4;
const MAX = 10;
type Phase = 'select' | 'running' | 'coverage' | 'failed';

let nextKey = 0;

export function SubmitPage() {
  const navigate = useNavigate();
  const mode = useAnalysisMode();
  const [phase, setPhase] = useState<Phase>('select');
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [claimId, setClaimId] = useState<string | null>(null);
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [report, setReport] = useState<ClaimReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const stopWatching = useRef<() => void>(() => {});
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => () => {
    stopWatching.current();
    for (const item of itemsRef.current) URL.revokeObjectURL(item.previewUrl);
  }, []);

  const addFiles = useCallback((files: File[]) => {
    const room = MAX - itemsRef.current.length;
    setMessage(files.length > room ? 'A claim can hold at most 10 photos.' : null);
    const added: PhotoItem[] = files.slice(0, Math.max(0, room)).map((file) => ({
      key: `photo-${nextKey++}`, file, previewUrl: URL.createObjectURL(file), quality: null, error: null,
    }));
    if (!added.length) return;
    setItems((prev) => [...prev, ...added]);
    for (const item of added) {
      checkImageQuality(item.file).then(
        (quality) => setItems((prev) => prev.map((p) => (p.key === item.key ? { ...p, quality } : p))),
        () => setItems((prev) => prev.map((p) => (p.key === item.key ? { ...p, error: 'Could not read this image' } : p))),
      );
    }
  }, []);

  const remove = (key: string) => {
    setItems((prev) => {
      const gone = prev.find((p) => p.key === key);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
    setMessage(null);
  };

  const watch = useCallback((id: string) => {
    stopWatching.current();
    setEvents([]);
    setFailure(null);
    setPhase('running');
    stopWatching.current = api.watchClaim(id, (event) => {
      if (event.type === 'stage') {
        setEvents((prev) => [...prev, event]);
      } else if (event.type === 'failed') {
        setFailure(event.error);
        setPhase('failed');
      } else {
        api.getClaim(id).then(
          (r) => {
            if (r.coverage.complete) navigate(`/claims/${id}`);
            else { setReport(r); setPhase('coverage'); }
          },
          (err: Error) => { setFailure(err.message); setPhase('failed'); },
        );
      }
    });
  }, [navigate]);

  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { id } = await api.createClaim(items.map((i) => i.file));
      setClaimId(id);
      watch(id);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Upload failed.');
      // The server's quality check is authoritative; show its verdict on each photo.
      const serverPhotos = err instanceof ApiError ? err.photos : undefined;
      if (serverPhotos) {
        setItems((prev) => prev.map((p) => {
          const match = serverPhotos.find((s) => s.filename === p.file.name);
          return match ? { ...p, quality: match.quality } : p;
        }));
      }
    } finally {
      setBusy(false);
    }
  };

  const addToClaim = async (files: File[]) => {
    if (!claimId) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.addPhotos(claimId, files);
      watch(claimId);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!claimId) return;
    try {
      await api.retryClaim(claimId);
      watch(claimId);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'Retry failed.');
    }
  };

  const startOver = () => {
    stopWatching.current();
    for (const item of items) URL.revokeObjectURL(item.previewUrl);
    setItems([]);
    setClaimId(null);
    setReport(null);
    setMessage(null);
    setPhase('select');
  };

  if (phase === 'running') return <PipelineProgress events={events} mode={mode} />;

  if (phase === 'failed') {
    return (
      <section className="card">
        <h1>Analysis failed</h1>
        <p className="inline-error" role="alert">{failure}</p>
        <div className="row-actions">
          <button type="button" className="btn btn-primary" onClick={retry}>Retry analysis</button>
          <button type="button" className="btn" onClick={startOver}>Start over</button>
        </div>
      </section>
    );
  }

  if (phase === 'coverage' && report) {
    return (
      <CoveragePrompt
        prompts={report.coverage.prompts}
        canAdd={report.photos.length < MAX}
        busy={busy}
        error={message}
        onAdd={addToClaim}
        onContinue={() => navigate(`/claims/${report.id}`)}
      />
    );
  }

  const checking = items.some((i) => !i.quality && !i.error);
  const passed = items.filter((i) => i.quality?.pass).length;
  const blocker =
    items.length < MIN ? `Add at least ${MIN} photos (${items.length} so far).`
    : checking ? 'Checking photo quality…'
    : passed < MIN ? `At least ${MIN} photos must pass the quality check (${passed} passed).`
    : null;

  return (
    <div className="stack">
      <div>
        <h1>Submit a damage claim</h1>
        <p className="muted">
          Upload 4 to 10 photos of the vehicle. Include the front, a side and the rear so every part can be inspected.
        </p>
      </div>
      <DropZone onFiles={addFiles} disabled={busy || items.length >= MAX} />
      {message && <p className="inline-error" role="alert">{message}</p>}
      {items.length > 0 && (
        <ul className="photo-grid">
          {items.map((item) => <PhotoCard key={item.key} item={item} onRemove={() => remove(item.key)} />)}
        </ul>
      )}
      <div className="submit-bar card">
        <div>
          <strong>{items.length} of {MAX} photos</strong>
          <span className="muted">, {passed} passed the quality check</span>
          {blocker && <div className="muted small">{blocker}</div>}
        </div>
        <button type="button" className="btn btn-primary" disabled={blocker !== null || busy} onClick={submit}>
          {busy ? 'Uploading…' : 'Run analysis'}
        </button>
      </div>
    </div>
  );
}
