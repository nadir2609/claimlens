import { DatabaseSync } from 'node:sqlite';
import type { ClaimReport, ClaimStatus, ClaimSummary } from '@claimlens/shared';
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

  hashesExcluding(claimId: string): PriorHash[] {
    const rows = this.db.prepare(
      'SELECT claim_id AS claimId, photo_id AS photoId, sha256, dhash FROM photo_hashes WHERE claim_id <> ?',
    ).all(claimId);
    return rows as unknown as PriorHash[];
  }

  close(): void { this.db.close(); }
}
