import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ACTIONS, CLAIM_STATUSES, type ClaimStatus, type ClaimSummary } from '@claimlens/shared';
import { api } from '../api';
import { Badge, actionTone, levelTone, statusLabel, statusTone } from '../components/Badge';
import { filterClaims, sortClaims, type ClaimFilters, type SortKey } from '../lib/claimsFilter';
import { money, shortDate } from '../lib/format';

const NO_FILTERS: ClaimFilters = { search: '', action: 'all', status: 'all', fraudBand: 'all' };
const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: 'id', label: 'Claim ID' },
  { key: 'vehicle', label: 'Vehicle' },
  { key: 'totalCost', label: 'Total Cost', numeric: true },
  { key: 'fraudScore', label: 'Fraud Score', numeric: true },
  { key: 'action', label: 'Recommended Action' },
  { key: 'status', label: 'Status' },
  { key: 'createdAt', label: 'Submitted' },
];

export function ClaimsPage() {
  const [claims, setClaims] = useState<ClaimSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ClaimFilters>(NO_FILTERS);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'createdAt', dir: 'desc' });
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setError(null);
    api.listClaims().then(setClaims, (err: Error) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  const visible = useMemo(
    () => sortClaims(filterClaims(claims ?? [], filters), sort.key, sort.dir),
    [claims, filters, sort],
  );
  const filtering = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);

  const sortBy = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const changeStatus = (id: string, status: ClaimStatus) => {
    setRowErrors((e) => ({ ...e, [id]: '' }));
    api.setStatus(id, status).then(
      (r) => setClaims((prev) => (prev ?? []).map((c) => (c.id === id ? { ...c, status: r.status } : c))),
      (err: Error) => setRowErrors((e) => ({ ...e, [id]: err.message })),
    );
  };

  if (error) {
    return (
      <section className="card">
        <h1>Could not load claims</h1>
        <p className="inline-error" role="alert">{error}</p>
        <button type="button" className="btn btn-primary" onClick={load}>Try again</button>
      </section>
    );
  }
  if (!claims) return <p className="muted" aria-busy="true">Loading claims…</p>;
  if (claims.length === 0) {
    return (
      <div className="empty-state">
        <h1>No claims yet</h1>
        <p>Submitted claims will appear here for review.</p>
        <p><Link className="btn btn-primary" to="/">Submit a claim</Link></p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div>
        <h1>Adjuster portal</h1>
        <p className="muted">All submitted claims. Open a claim to see its full assessment.</p>
      </div>

      <div className="card filters">
        <label>
          <span>Search</span>
          <input
            type="search" placeholder="Claim ID or vehicle" value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
        </label>
        <label>
          <span>Recommended action</span>
          <select value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value as ClaimFilters['action'] })}>
            <option value="all">All</option>
            {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label>
          <span>Status</span>
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as ClaimFilters['status'] })}>
            <option value="all">All</option>
            {CLAIM_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select>
        </label>
        <label>
          <span>Fraud risk</span>
          <select value={filters.fraudBand} onChange={(e) => setFilters({ ...filters, fraudBand: e.target.value as ClaimFilters['fraudBand'] })}>
            <option value="all">All</option>
            <option value="Low">Low</option>
            <option value="Medium">Medium</option>
            <option value="High">High</option>
          </select>
        </label>
        <div className="filters-end">
          <span className="muted small" aria-live="polite">Showing {visible.length} of {claims.length}</span>
          {filtering && <button type="button" className="btn btn-ghost" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
        </div>
      </div>

      <div className="card table-card">
        <div className="table-scroll">
          <table className="table claims-table">
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className={col.numeric ? 'r' : ''}
                    aria-sort={sort.key === col.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button type="button" className="th-sort" onClick={() => sortBy(col.key)}>
                      {col.label}
                      <span aria-hidden="true">{sort.key === col.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
                    </button>
                  </th>
                ))}
                <th><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/claims/${c.id}`} className="claim-link">{c.id}</Link></td>
                  <td>{c.vehicle}</td>
                  <td className="r num">{c.state === 'done' ? money(c.totalCost) : '–'}</td>
                  <td className="r">
                    {c.state === 'done' ? (
                      <span className="score-pair">
                        <span className="num">{c.fraudScore}</span>
                        <Badge tone={levelTone(c.fraudBand)}>{c.fraudBand}</Badge>
                      </span>
                    ) : '–'}
                  </td>
                  <td>
                    {c.state === 'done' ? <Badge tone={actionTone(c.action)}>{c.action}</Badge>
                      : c.state === 'failed' ? <Badge tone="bad">Analysis failed</Badge>
                      : <Badge tone="neutral">Analysing…</Badge>}
                  </td>
                  <td><Badge tone={statusTone(c.status)}>{statusLabel(c.status)}</Badge></td>
                  <td className="muted nowrap">{shortDate(c.createdAt)}</td>
                  <td>
                    <div className="row-buttons">
                      <button type="button" className="btn btn-small btn-good" disabled={c.status === 'approved'} onClick={() => changeStatus(c.id, 'approved')}>
                        Approve<span className="visually-hidden"> {c.id}</span>
                      </button>
                      <button type="button" className="btn btn-small btn-bad" disabled={c.status === 'rejected'} onClick={() => changeStatus(c.id, 'rejected')}>
                        Reject<span className="visually-hidden"> {c.id}</span>
                      </button>
                      <button type="button" className="btn btn-small btn-ghost" disabled={c.status === 'pending'} onClick={() => changeStatus(c.id, 'pending')}>
                        Reset<span className="visually-hidden"> {c.id}</span>
                      </button>
                    </div>
                    {rowErrors[c.id] && <div className="inline-error small" role="alert">{rowErrors[c.id]}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visible.length === 0 && <p className="muted table-empty">No claims match these filters.</p>}
      </div>
    </div>
  );
}
