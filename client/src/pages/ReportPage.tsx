import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ClaimReport, ClaimStatus, PipelineEvent } from '@claimlens/shared';
import { ApiError, api } from '../api';
import { Badge, levelTone, statusLabel, statusTone } from '../components/Badge';
import { DamageViewer, SEVERITY_COLOR, type ActiveDamage } from '../components/DamageViewer';
import { PipelineProgress } from '../components/PipelineProgress';
import {
  ActionBanner, CostTable, CoverageChecklist, FraudPanel, SeverityGauge, VehicleCard,
} from '../components/ReportPanels';
import { shortDate } from '../lib/format';
import { NotFoundPage } from './NotFoundPage';

function downloadJson(report: ClaimReport) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${report.id}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function ReportPage() {
  const { id = '' } = useParams();
  const [report, setReport] = useState<ClaimReport | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [photoId, setPhotoId] = useState('');
  const [active, setActive] = useState<ActiveDamage | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const stopWatching = useRef<() => void>(() => {});

  const load = useCallback(() => {
    setError(null);
    api.getClaim(id).then(
      (r) => {
        setReport(r);
        setPhotoId((current) => current || (r.photos.find((p) => p.damages.length) ?? r.photos[0])?.id || '');
        if (r.state === 'processing') {
          setEvents([]);
          stopWatching.current();
          stopWatching.current = api.watchClaim(id, (event) => {
            if (event.type === 'stage') setEvents((prev) => [...prev, event]);
            else load();
          });
        }
      },
      (err: Error) => {
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else setError(err.message);
      },
    );
  }, [id]);

  useEffect(() => {
    setReport(null);
    setMissing(false);
    setPhotoId('');
    load();
    return () => stopWatching.current();
  }, [load]);

  const retry = () => {
    api.retryClaim(id).then(load, (err: Error) => setError(err.message));
  };

  const changeStatus = (status: ClaimStatus) => {
    setStatusError(null);
    api.setStatus(id, status).then(setReport, (err: Error) => setStatusError(err.message));
  };

  if (missing) return <NotFoundPage what="Claim" />;
  if (error) {
    return (
      <section className="card">
        <h1>Could not load this claim</h1>
        <p className="inline-error" role="alert">{error}</p>
        <button type="button" className="btn btn-primary" onClick={load}>Try again</button>
      </section>
    );
  }
  if (!report) return <p className="muted" aria-busy="true">Loading claim…</p>;
  if (report.state === 'processing') return <PipelineProgress events={events} mode={report.analysisMode} />;
  if (report.state === 'failed') {
    return (
      <section className="card">
        <h1>Analysis failed for {report.id}</h1>
        <p className="inline-error" role="alert">{report.error}</p>
        <div className="row-actions">
          <button type="button" className="btn btn-primary" onClick={retry}>Retry analysis</button>
          <Link className="btn" to="/claims">Back to claims</Link>
        </div>
      </section>
    );
  }

  const damaged = report.photos.filter((p) => p.damages.length > 0);

  return (
    <div className="stack report">
      <header className="report-head">
        <div>
          <div className="muted small">Assessment report</div>
          <h1>{report.id}</h1>
          <div className="report-tags">
            <span className="muted">Submitted {shortDate(report.createdAt)}</span>
            <Badge tone={statusTone(report.status)}>{statusLabel(report.status)}</Badge>
            {report.analysisMode === 'demo' && (
              <Badge tone="warn" title="No API key set: analysis results are simulated">Simulated analysis</Badge>
            )}
          </div>
        </div>
        <div className="row-actions no-print">
          <button type="button" className="btn" onClick={() => downloadJson(report)}>Export JSON</button>
          <button type="button" className="btn" onClick={() => window.print()}>Print / PDF</button>
          <button
            type="button" className="btn btn-good" disabled={report.status === 'approved'}
            onClick={() => changeStatus('approved')}
          >
            Approve
          </button>
          <button
            type="button" className="btn btn-bad" disabled={report.status === 'rejected'}
            onClick={() => changeStatus('rejected')}
          >
            Reject
          </button>
        </div>
      </header>
      {statusError && <p className="inline-error" role="alert">{statusError}</p>}

      <ActionBanner recommendation={report.recommendation} />

      <div className="report-grid">
        <div className="stack no-print">
          <DamageViewer
            photos={report.photos}
            selectedPhotoId={photoId}
            onSelectPhoto={setPhotoId}
            active={active}
            onActive={setActive}
          />
        </div>
        <div className="stack">
          <VehicleCard vehicle={report.vehicle} />
          <SeverityGauge score={report.severity.score} band={report.severity.band} />
          <FraudPanel fraud={report.fraud} />
          <CoverageChecklist coverage={report.coverage} />
        </div>
      </div>

      <CostTable cost={report.cost} />

      {/* Print-only: every damaged photo with its boxes, since the interactive viewer shows one at a time. */}
      <section className="print-only">
        <h2>Annotated photos</h2>
        {damaged.length === 0 && <p>No damage detected in any photo.</p>}
        {damaged.map((p) => (
          <figure key={p.id} className="print-photo">
            <div className="print-photo-frame">
              <img src={p.url} alt="" />
              {p.damages.map((d, i) => (
                <span
                  key={i}
                  className="print-box"
                  style={{
                    left: `${d.bbox[0] * 100}%`, top: `${d.bbox[1] * 100}%`,
                    width: `${d.bbox[2] * 100}%`, height: `${d.bbox[3] * 100}%`,
                    borderColor: SEVERITY_COLOR[d.severity],
                  }}
                >
                  <span className="print-box-num">{i + 1}</span>
                </span>
              ))}
            </div>
            <figcaption>
              <strong>{p.filename}</strong>{p.angle ? ` (${p.angle} view)` : ''}
              <ol>
                {p.damages.map((d, i) => (
                  <li key={i}>{d.part}: {d.type}, {d.severity} severity. {d.note}</li>
                ))}
              </ol>
            </figcaption>
          </figure>
        ))}
      </section>

      <section className="card">
        <h2>Damage summary</h2>
        {report.damages.length === 0 ? (
          <p className="muted">No damage detected.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr><th>Part</th><th>Damage type</th><th>Severity</th><th className="r">Score</th><th>Seen in</th></tr>
              </thead>
              <tbody>
                {report.damages.map((d) => (
                  <tr key={d.id}>
                    <td>{d.part}</td>
                    <td>{d.type}</td>
                    <td><Badge tone={levelTone(d.severity)}>{d.severity}</Badge></td>
                    <td className="r num">{d.score}</td>
                    <td className="muted">
                      {d.photoIds.map((pid) => `Photo ${report.photos.findIndex((p) => p.id === pid) + 1}`).join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
