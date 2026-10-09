import type { ReactNode } from 'react';
import type { Band3, ClaimStatus, RecommendedAction, Severity } from '@claimlens/shared';

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

// Each tone has its own shape so meaning never rests on colour alone.
const GLYPH: Record<Tone, string> = { good: '●', warn: '▲', bad: '◆', info: '■', neutral: '○' };

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      <span className="badge-glyph" aria-hidden="true">{GLYPH[tone]}</span>
      {children}
    </span>
  );
}

export const levelTone = (level: Severity | Band3): Tone =>
  level === 'High' ? 'bad' : level === 'Medium' ? 'warn' : 'good';

export const actionTone = (action: RecommendedAction): Tone =>
  action === 'Fast-track approval' ? 'good' : action === 'Standard review' ? 'info' : 'bad';

export const statusTone = (status: ClaimStatus): Tone =>
  status === 'approved' ? 'good' : status === 'rejected' ? 'bad' : 'neutral';

export const statusLabel = (status: ClaimStatus): string =>
  status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'Pending review';
