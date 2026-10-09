import { DatabaseSync } from 'node:sqlite';
import type { ClaimReport, ClaimStatus, ClaimSummary, PartListing } from '@claimlens/shared';
import type { PriorHash } from './pipeline/fraud';

const vehicleLabel = (r: ClaimReport) =>
  [r.vehicle.year, r.vehicle.make, r.vehicle.model].filter((s) => s && s !== 'Unknown').join(' ') || 'Unknown vehicle';

export class ClaimStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY, year INTEGER NOT NULL, seq INTEGER NOT NULL, created_at TEXT NOT NULL,
        status TEXT NOT NULL, state TEXT NOT NULL, vehicle TEXT NOT NULL, total_cost REAL NOT NULL,
        fraud_score INTEGER NOT NULL, action TEXT NOT NULL, report TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS photo_hashes (
        claim_id TEXT NOT NULL, photo_id TEXT NOT NULL, sha256 TEXT NOT NULL, dhash TEXT NOT NULL,
        PRIMARY KEY (claim_id, photo_id)
      );
      CREATE INDEX IF NOT EXISTS claims_created ON claims (created_at);
      CREATE TABLE IF NOT EXISTS part_price_cache (
        key TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, listings TEXT NOT NULL
      );
    `);
  }

  nextId(now = new Date()): string {
    const year = now.getUTCFullYear();
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM claims WHERE year = ?').get(year) as { seq: number };
    return `CLM-${year}-${String(row.seq + 1).padStart(4, '0')}`;
  }

  insert(report: ClaimReport): void {
    const [, year, seq] = report.id.split('-');
    this.db.prepare(
      `INSERT INTO claims (id, year, seq, created_at, status, state, vehicle, total_cost, fraud_score, action, report)
       VALUES (?, ?, ?, ?, '', '', '', 0, 0, '', '')`,
    ).run(report.id, Number(year), Number(seq), report.createdAt);
    this.save(report);
  }

  save(report: ClaimReport): void {
    this.db.prepare(
      `UPDATE claims SET status = ?, state = ?, vehicle = ?, total_cost = ?, fraud_score = ?, action = ?, report = ? WHERE id = ?`,
    ).run(report.status, report.state, vehicleLabel(report), report.cost.total, report.fraud.score,
      report.recommendation.action, JSON.stringify(report), report.id);
    this.db.prepare('DELETE FROM photo_hashes WHERE claim_id = ?').run(report.id);
    const add = this.db.prepare('INSERT INTO photo_hashes (claim_id, photo_id, sha256, dhash) VALUES (?, ?, ?, ?)');
    for (const p of report.photos) add.run(report.id, p.id, p.sha256, p.dhash);
  }

  get(id: string): ClaimReport | null {
    const row = this.db.prepare('SELECT report FROM claims WHERE id = ?').get(id) as { report: string } | undefined;
    return row ? (JSON.parse(row.report) as ClaimReport) : null;
  }

  list(): ClaimSummary[] {
    const rows = this.db.prepare('SELECT report FROM claims ORDER BY created_at DESC, seq DESC').all() as { report: string }[];
    return rows.map((row) => {
      const r = JSON.parse(row.report) as ClaimReport;
      return {
        id: r.id, createdAt: r.createdAt, vehicle: vehicleLabel(r), totalCost: r.cost.total,
        fraudScore: r.fraud.score, fraudBand: r.fraud.band, severityScore: r.severity.score,
        action: r.recommendation.action, status: r.status, state: r.state, thumbnailUrl: r.photos[0]?.url ?? null,
      };
    });
  }

  setStatus(id: string, status: ClaimStatus): ClaimReport | null {
    const report = this.get(id);
    if (!report) return null;
    report.status = status;
    this.save(report);
    return report;
  }

  /** Photo hashes from claims submitted before this one. */
  earlierHashes(claimId: string): PriorHash[] {
    const rows = this.db.prepare(
      `SELECT h.claim_id AS claimId, h.photo_id AS photoId, h.sha256, h.dhash
       FROM photo_hashes h
       JOIN claims c ON c.id = h.claim_id
       JOIN claims me ON me.id = ?
       WHERE c.year < me.year OR (c.year = me.year AND c.seq < me.seq)`,
    ).all(claimId);
    return rows as unknown as PriorHash[];
  }

  /** Runs live only in memory, so any claim still "processing" at startup was cut off. Returns how many were marked. */
  failInterrupted(): number {
    const rows = this.db.prepare("SELECT id FROM claims WHERE state = 'processing'").all() as { id: string }[];
    for (const { id } of rows) {
      const report = this.get(id)!;
      report.state = 'failed';
      report.error = 'Analysis was interrupted before it finished. Retry to run it again.';
      this.save(report);
    }
    return rows.length;
  }

  /** Cached marketplace search results, keyed by the search URL. */
  getListings(key: string): { fetchedAt: number; listings: PartListing[] } | null {
    const row = this.db.prepare('SELECT fetched_at AS fetchedAt, listings FROM part_price_cache WHERE key = ?').get(key) as
      { fetchedAt: number; listings: string } | undefined;
    return row ? { fetchedAt: row.fetchedAt, listings: JSON.parse(row.listings) as PartListing[] } : null;
  }

  setListings(key: string, listings: PartListing[], fetchedAt: number): void {
    this.db.prepare(
      'INSERT INTO part_price_cache (key, fetched_at, listings) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at, listings = excluded.listings',
    ).run(key, fetchedAt, JSON.stringify(listings));
  }

  close(): void { this.db.close(); }
}
