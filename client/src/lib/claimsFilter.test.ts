import { describe, expect, it } from 'vitest';
import type { ClaimSummary } from '@claimlens/shared';
import { filterClaims, sortClaims, type ClaimFilters } from './claimsFilter';

const claim = (over: Partial<ClaimSummary>): ClaimSummary => ({
  id: 'CLM-2026-0001', createdAt: '2026-10-01T00:00:00.000Z', vehicle: '2022 Toyota Camry', totalCost: 1000,
  fraudScore: 10, fraudBand: 'Low', severityScore: 20, action: 'Fast-track approval', status: 'pending',
  state: 'done', thumbnailUrl: null, ...over,
});
const all: ClaimFilters = { search: '', action: 'all', status: 'all', fraudBand: 'all' };
const claims = [
  claim({}),
  claim({ id: 'CLM-2026-0002', vehicle: '2020 BMW 3 Series', totalCost: 9000, fraudScore: 70, fraudBand: 'High', action: 'Manual Adjuster Review Required', status: 'rejected' }),
  claim({ id: 'CLM-2026-0003', vehicle: '2021 Honda CR-V', totalCost: 3000, fraudScore: 35, fraudBand: 'Medium', action: 'Standard review', status: 'approved' }),
];

describe('claims filtering and sorting', () => {
  it('searches claim id and vehicle, case-insensitively', () => {
    expect(filterClaims(claims, { ...all, search: 'bmw' }).map((c) => c.id)).toEqual(['CLM-2026-0002']);
    expect(filterClaims(claims, { ...all, search: '0003' }).map((c) => c.id)).toEqual(['CLM-2026-0003']);
  });

  it('combines filters', () => {
    expect(filterClaims(claims, { ...all, fraudBand: 'High', status: 'rejected' })).toHaveLength(1);
    expect(filterClaims(claims, { ...all, action: 'Standard review', status: 'pending' })).toHaveLength(0);
    expect(filterClaims(claims, all)).toHaveLength(3);
  });

  it('sorts numbers numerically and text alphabetically, in both directions, without mutating', () => {
    expect(sortClaims(claims, 'totalCost', 'desc').map((c) => c.totalCost)).toEqual([9000, 3000, 1000]);
    expect(sortClaims(claims, 'vehicle', 'asc').map((c) => c.id)).toEqual(['CLM-2026-0002', 'CLM-2026-0003', 'CLM-2026-0001']);
    expect(claims[0].id).toBe('CLM-2026-0001');
  });
});
