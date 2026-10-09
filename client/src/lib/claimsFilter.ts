import type { Band3, ClaimStatus, ClaimSummary, RecommendedAction } from '@claimlens/shared';

export interface ClaimFilters {
  search: string;
  action: RecommendedAction | 'all';
  status: ClaimStatus | 'all';
  fraudBand: Band3 | 'all';
}
export type SortKey = 'id' | 'vehicle' | 'totalCost' | 'fraudScore' | 'action' | 'status' | 'createdAt';

export function filterClaims(claims: ClaimSummary[], f: ClaimFilters): ClaimSummary[] {
  const q = f.search.trim().toLowerCase();
  return claims.filter((c) =>
    (!q || c.id.toLowerCase().includes(q) || c.vehicle.toLowerCase().includes(q)) &&
    (f.action === 'all' || c.action === f.action) &&
    (f.status === 'all' || c.status === f.status) &&
    (f.fraudBand === 'all' || c.fraudBand === f.fraudBand));
}

export function sortClaims(claims: ClaimSummary[], key: SortKey, dir: 'asc' | 'desc'): ClaimSummary[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...claims].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return order * sign;
  });
}
