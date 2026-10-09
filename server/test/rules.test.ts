import { describe, expect, it } from 'vitest';
import type { Coverage, Damage, DamageItem } from '@claimlens/shared';
import { PARTS } from '@claimlens/shared';
import { assessCoverage } from '../src/pipeline/coverage';
import { mergeDamages, scoreSeverity } from '../src/pipeline/severity';
import { estimateCost, makeTier } from '../src/pipeline/cost';
import { assessFraud, hamming } from '../src/pipeline/fraud';
import { recommend } from '../src/pipeline/action';

const dmg = (part: Damage['part'], type: Damage['type'], severity: Damage['severity']): Damage =>
  ({ part, type, severity, bbox: [0.1, 0.1, 0.2, 0.2], confidence: 0.9, note: '' });
const item = (part: Damage['part'], type: Damage['type'], severity: Damage['severity']): DamageItem =>
  mergeDamages([{ id: 'p1', damages: [dmg(part, type, severity)] }])[0];
const fullCoverage: Coverage = {
  angles: { front: true, side: true, rear: true },
  parts: Object.fromEntries(PARTS.map((p) => [p, true])) as Coverage['parts'],
  prompts: [],
  complete: true,
};

describe('coverage', () => {
  it('is complete when corner shots cover every angle and all parts are seen', () => {
    const c = assessCoverage([
      { angle: 'front-left', visibleParts: ['Front Bumper', 'Hood', 'Headlights', 'Windshield', 'Fenders', 'Doors'] },
      { angle: 'rear-right', visibleParts: ['Rear Bumper'] },
    ]);
    expect(c.complete).toBe(true);
    expect(c.prompts).toEqual([]);
  });

  it('prompts for missing angles and parts', () => {
    const c = assessCoverage([{ angle: 'left', visibleParts: ['Doors', 'Fenders'] }]);
    expect(c.angles).toEqual({ front: false, side: true, rear: false });
    expect(c.parts['Front Bumper']).toBe(false);
    expect(c.complete).toBe(false);
    expect(c.prompts).toContain('No front view found. Please add a photo of the front of the vehicle.');
    expect(c.prompts).toContain('No rear view found. Please add a photo of the back of the vehicle.');
    expect(c.prompts).toContain('Please upload a clearer image of the front bumper.');
  });

  it('ignores photos that were not analysed', () => {
    expect(assessCoverage([{ angle: null, visibleParts: [] }]).angles.side).toBe(false);
  });
});

describe('severity', () => {
  it('merges the same part and type across photos, keeping the highest severity', () => {
    const items = mergeDamages([
      { id: 'p1', damages: [dmg('Doors', 'Dent', 'Medium')] },
      { id: 'p2', damages: [dmg('Doors', 'Dent', 'High')] },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'doors-dent', severity: 'High', score: 32, photoIds: ['p1', 'p2'] });
  });

  it('sums weighted items and bands the score', () => {
    const items = [item('Doors', 'Dent', 'High'), item('Hood', 'Scratch', 'Low')];
    expect(scoreSeverity(items)).toEqual({ score: 37, band: 'Moderate' });
  });

  it('caps at 100 and scores an undamaged vehicle as 0', () => {
    const many = PARTS.map((p) => item(p, 'Severe Deformation', 'High'));
    expect(scoreSeverity(many)).toEqual({ score: 100, band: 'Severe' });
    expect(scoreSeverity([])).toEqual({ score: 0, band: 'Minor' });
  });
});

describe('cost', () => {
  it('prices a repair with paint and labour only', () => {
    const c = estimateCost([item('Doors', 'Dent', 'Medium')], 'Toyota');
    expect(c.lines[0]).toMatchObject({ operation: 'Repair', parts: 0, paint: 300, laborHours: 3, labor: 285, total: 585, partsBasis: 'none' });
    expect(c.total).toBe(585);
    expect(c.currency).toBe('USD');
    expect(c.makeTier).toBe('economy');
  });

  it('replaces the part at high severity, scaled by make tier', () => {
    const c = estimateCost([item('Front Bumper', 'Dent', 'High')], 'bmw');
    expect(c.lines[0]).toMatchObject({ operation: 'Replace', parts: 855, paint: 450, laborHours: 5, labor: 475, total: 1780, partsBasis: 'estimate', partListing: null });
  });

  it('always replaces broken glass, with no paint, and uses the mid tier for unknown makes', () => {
    const c = estimateCost([item('Windshield', 'Broken Glass', 'Low')], 'Unknown');
    expect(c.lines[0]).toMatchObject({ operation: 'Replace', parts: 520, paint: 0, laborHours: 1.5, labor: 142.5, total: 662.5 });
    expect(c.tierMultiplier).toBe(1.3);
  });

  it('totals equal the sum of the lines, and an empty estimate is zero', () => {
    const c = estimateCost(
      [item('Doors', 'Dent', 'Medium'), item('Hood', 'Scratch', 'Low'), item('Headlights', 'Crack', 'High')], 'Audi');
    expect(c.total).toBeCloseTo(c.lines.reduce((s, l) => s + l.total, 0), 2);
    expect(c.total).toBeCloseTo(c.partsTotal + c.paintTotal + c.laborTotal, 2);
    expect(estimateCost([], 'Toyota').total).toBe(0);
  });

  it('uses the cheapest marketplace listing for a replaced part instead of the estimate', () => {
    const cheapest = { title: 'TECHPRO BM1000100 (Front)', price: 417.61, url: 'https://www.rockauto.com/en/moreinfo.php?pk=1', source: 'rockauto.com' };
    const other = { ...cheapest, price: 600, url: 'https://www.rockauto.com/en/moreinfo.php?pk=2' };
    const searchLinks = [{ source: 'rockauto.com', url: 'https://www.rockauto.com/en/catalog/bmw,2015,328i' }];
    const offers = {
      'Front Bumper': { offer: { cheapest, alternatives: [other] }, similar: [], searchLinks },
      Doors: { offer: { cheapest, alternatives: [] }, similar: [], searchLinks },
    };
    const c = estimateCost([item('Front Bumper', 'Dent', 'High'), item('Doors', 'Dent', 'Medium')], 'BMW', offers);
    expect(c.lines[0]).toMatchObject({ parts: 417.61, partsBasis: 'listing', partListing: cheapest, alternatives: [other], searchLinks, total: 1342.61 });
    // A repaired part needs no replacement part, so a listing is not charged.
    expect(c.lines[1]).toMatchObject({ parts: 0, partsBasis: 'none', partListing: null });
  });

  it('keeps reference listings and search links on a line that had to be estimated', () => {
    const similar = [{ title: 'Bumper cover for another vehicle', price: 500, url: 'https://www.rockauto.com/en/moreinfo.php?pk=9', source: 'rockauto.com' }];
    const searchLinks = [{ source: 'rockauto.com', url: 'https://www.rockauto.com/en/catalog/lada' }];
    const c = estimateCost([item('Front Bumper', 'Dent', 'High')], 'Lada', { 'Front Bumper': { offer: null, similar, searchLinks } });
    expect(c.lines[0]).toMatchObject({ partsBasis: 'estimate', partListing: null, similarListings: similar, searchLinks, parts: 585 });
  });

  it('charges a part and its paint once when the same part has two kinds of damage', () => {
    const c = estimateCost([item('Fenders', 'Severe Deformation', 'High'), item('Fenders', 'Paint Damage', 'Low')], 'Toyota');
    expect(c.lines[0]).toMatchObject({ operation: 'Replace', parts: 380, paint: 450, partsBasis: 'estimate' });
    expect(c.lines[1]).toMatchObject({ operation: 'Repair', parts: 0, paint: 0, laborHours: 1.5 });

    const two = estimateCost([item('Headlights', 'Severe Deformation', 'High'), item('Headlights', 'Broken Glass', 'High')], 'Toyota');
    expect(two.lines.map((l) => l.parts)).toEqual([350, 0]);
    expect(two.lines[1].partsBasis).toBe('included');
    expect(two.partsTotal).toBe(350);
  });

  it('matches make names loosely', () => {
    expect(makeTier('Mercedes').tier).toBe('luxury');
    expect(makeTier('HONDA').tier).toBe('economy');
    expect(makeTier('').tier).toBe('mid');
  });
});

describe('fraud', () => {
  const photo = (id: string, over: Partial<{ sha256: string; dhash: string; software: string | null; capturedAt: string | null }> = {}) =>
    ({ id, sha256: `sha-${id}`, dhash: '00000000000000ff', software: null, capturedAt: '2026-10-01T10:00:00.000Z', ...over });
  const base = { priorHashes: [], observations: [], totalCost: 1000 };

  it('scores a clean claim as 0', () => {
    expect(assessFraud({ ...base, photos: [photo('p1'), photo('p2')] })).toMatchObject({ score: 0, band: 'Low', signals: [] });
  });

  it('flags exact and near duplicates from earlier claims', () => {
    const exact = assessFraud({ ...base, photos: [photo('p1')],
      priorHashes: [{ claimId: 'CLM-2026-0001', photoId: 'p3', sha256: 'sha-p1', dhash: 'ffffffffffffffff' }] });
    expect(exact.score).toBe(40);
    expect(exact.band).toBe('Medium');
    expect(exact.signals[0].detail).toContain('CLM-2026-0001');

    const near = assessFraud({ ...base, photos: [photo('p1')],
      priorHashes: [{ claimId: 'CLM-2026-0002', photoId: 'p1', sha256: 'other', dhash: '00000000000000fc' }] });
    expect(near.score).toBe(40);

    const far = assessFraud({ ...base, photos: [photo('p1')],
      priorHashes: [{ claimId: 'CLM-2026-0002', photoId: 'p1', sha256: 'other', dhash: 'ffffffffffffffff' }] });
    expect(far.score).toBe(0);
  });

  it('flags editing software and widely spread capture dates', () => {
    expect(assessFraud({ ...base, photos: [photo('p1', { software: 'Adobe Photoshop 25.0' })] }).score).toBe(20);
    expect(assessFraud({ ...base, photos: [photo('p1'), photo('p2', { capturedAt: '2026-08-01T10:00:00.000Z' })] }).score).toBe(10);
  });

  it('scores analyzer observations once per kind and caps at 100', () => {
    const f = assessFraud({
      photos: [photo('p1')],
      priorHashes: [{ claimId: 'CLM-2026-0001', photoId: 'p1', sha256: 'sha-p1', dhash: '0' }],
      observations: [
        { kind: 'vehicle_mismatch', detail: 'a' }, { kind: 'vehicle_mismatch', detail: 'b' },
        { kind: 'screen_recapture', detail: 'c' },
      ],
      totalCost: 1000,
    });
    expect(f.score).toBe(100);
    expect(f.band).toBe('High');
    expect(f.signals.filter((s) => s.kind === 'vehicle_mismatch')).toHaveLength(1);
  });

  it('flags totals above $12,000 only', () => {
    expect(assessFraud({ ...base, photos: [photo('p1')], totalCost: 12000 }).score).toBe(0);
    expect(assessFraud({ ...base, photos: [photo('p1')], totalCost: 12000.01 }).score).toBe(10);
  });

  it('reports missing EXIF as a note without scoring it', () => {
    const f = assessFraud({ ...base, photos: [photo('p1', { capturedAt: null })] });
    expect(f.score).toBe(0);
    expect(f.notes[0]).toMatch(/no EXIF/i);
  });

  it('computes Hamming distance between hex hashes', () => {
    expect(hamming('00000000000000ff', '00000000000000fc')).toBe(2);
  });
});

describe('recommendation', () => {
  const ok = { fraudScore: 0, severityScore: 10, totalCost: 500, coverage: fullCoverage };

  it('fast-tracks low-risk, minor, cheap claims, including undamaged vehicles', () => {
    expect(recommend(ok).action).toBe('Fast-track approval');
    expect(recommend({ ...ok, severityScore: 0, totalCost: 0 }).action).toBe('Fast-track approval');
  });

  it('requires manual review at each threshold', () => {
    expect(recommend({ ...ok, fraudScore: 60 }).action).toBe('Manual Adjuster Review Required');
    expect(recommend({ ...ok, severityScore: 60 }).action).toBe('Manual Adjuster Review Required');
    expect(recommend({ ...ok, totalCost: 8000 }).action).toBe('Standard review');
    expect(recommend({ ...ok, totalCost: 8000.01 }).action).toBe('Manual Adjuster Review Required');
    const gap = { ...fullCoverage, complete: false, parts: { ...fullCoverage.parts, Hood: false } };
    const r = recommend({ ...ok, coverage: gap });
    expect(r.action).toBe('Manual Adjuster Review Required');
    expect(r.reasons.join(' ')).toContain('Hood');
  });

  it('falls back to standard review and says why', () => {
    expect(recommend({ ...ok, totalCost: 2499.99 }).action).toBe('Fast-track approval');
    const r = recommend({ ...ok, totalCost: 2500 });
    expect(r.action).toBe('Standard review');
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(recommend({ ...ok, fraudScore: 30 }).action).toBe('Standard review');
    expect(recommend({ ...ok, severityScore: 25 }).action).toBe('Standard review');
  });
});
