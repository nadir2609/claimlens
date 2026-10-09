import { PARTS, type Coverage, type Recommendation } from '@claimlens/shared';

export function recommend(input: {
  fraudScore: number; severityScore: number; totalCost: number; coverage: Coverage;
}): Recommendation {
  const { fraudScore, severityScore, totalCost, coverage } = input;
  const missing = PARTS.filter((p) => !coverage.parts[p]);

  const manual: string[] = [];
  if (fraudScore >= 60) manual.push(`Fraud score ${fraudScore} is 60 or higher`);
  if (severityScore >= 60) manual.push(`Severity score ${severityScore} is 60 or higher`);
  if (totalCost > 8000) manual.push('Estimated total exceeds $8,000');
  if (missing.length) manual.push(`Not inspected: ${missing.join(', ')}`);
  if (manual.length) return { action: 'Manual Adjuster Review Required', reasons: manual };

  if (fraudScore < 30 && severityScore < 25 && totalCost < 2500) {
    return { action: 'Fast-track approval', reasons: ['Low fraud risk, minor damage, and total under $2,500'] };
  }

  const reasons: string[] = [];
  if (fraudScore >= 30) reasons.push(`Fraud score ${fraudScore} is 30 or higher`);
  if (severityScore >= 25) reasons.push(`Severity score ${severityScore} is 25 or higher`);
  if (totalCost >= 2500) reasons.push('Estimated total is $2,500 or more');
  return { action: 'Standard review', reasons };
}
