import {
  PARTS, type Coverage, type CostEstimate, type CostLine, type PartListing, type FraudAssessment, type Recommendation,
  type SeverityBand, type VehicleInfo,
} from '@claimlens/shared';
import { money } from '../lib/format';
import { Badge, actionTone, levelTone, type Tone } from './Badge';

export function ActionBanner({ recommendation }: { recommendation: Recommendation }) {
  const tone = actionTone(recommendation.action);
  return (
    <section className={`banner banner-${tone}`}>
      <div className="banner-label">Recommended action</div>
      <h2>{recommendation.action}</h2>
      {recommendation.reasons.length > 0 && (
        <ul>
          {recommendation.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
    </section>
  );
}

export function VehicleCard({ vehicle }: { vehicle: VehicleInfo }) {
  const rows: [string, string][] = [
    ['Make', vehicle.make], ['Model', vehicle.model], ['Year', vehicle.year], ['Body type', vehicle.bodyType],
  ];
  return (
    <section className="card">
      <h2>Vehicle</h2>
      <dl className="facts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className={value === 'Unknown' ? 'muted' : ''}>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="muted small">Identification confidence: {Math.round(vehicle.confidence * 100)}%</p>
    </section>
  );
}

const BANDS: { band: SeverityBand; from: number; to: number; tone: Tone }[] = [
  { band: 'Minor', from: 0, to: 24, tone: 'good' },
  { band: 'Moderate', from: 25, to: 59, tone: 'warn' },
  { band: 'Severe', from: 60, to: 100, tone: 'bad' },
];

export function SeverityGauge({ score, band }: { score: number; band: SeverityBand }) {
  const tone = BANDS.find((b) => b.band === band)!.tone;
  return (
    <section className="card">
      <h2>Damage severity</h2>
      <div className="gauge-head">
        <span className="gauge-score num">{score}</span>
        <span className="muted">/ 100</span>
        <Badge tone={tone}>{band}</Badge>
      </div>
      <div
        className="gauge"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
        aria-valuetext={`${score} out of 100, ${band}`}
        aria-label="Overall damage score"
      >
        <div className="gauge-track">
          {BANDS.map((b) => (
            <div key={b.band} className={`gauge-seg gauge-${b.tone}`} style={{ flexGrow: b.to - b.from + 1 }} />
          ))}
          <div className="gauge-marker" style={{ left: `${score}%` }} />
        </div>
        <div className="gauge-labels muted small" aria-hidden="true">
          {BANDS.map((b) => (
            <span key={b.band} style={{ flexGrow: b.to - b.from + 1 }}>
              {b.band} {b.from}–{b.to}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function ListingLinks({ listings }: { listings: PartListing[] }) {
  return (
    <ul>
      {listings.map((l) => (
        <li key={l.url}>
          <a href={l.url} target="_blank" rel="noreferrer">{l.title}</a>{' '}
          <span className="muted">({l.source})</span> <span className="num">{money(l.price)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Shows where a replaced part's price came from, with links a person can open to check:
 * the cheapest listing, other listings, the same part for other vehicles, and the search pages themselves.
 */
function PartSource({ line }: { line: CostLine }) {
  // Reports saved before live prices existed have none of these fields.
  const basis = line.partsBasis ?? (line.operation === 'Replace' ? 'estimate' : 'none');
  const alternatives = line.alternatives ?? [];
  const similar = line.similarListings ?? [];
  const searchLinks = line.searchLinks ?? [];
  if (basis === 'none') return null;
  if (basis === 'included') return <div className="part-source muted small">Part already counted on an earlier line</div>;

  return (
    <div className="part-source small">
      {basis === 'listing' && line.partListing ? (
        <div>
          Cheapest listing:{' '}
          <a href={line.partListing.url} target="_blank" rel="noreferrer">{line.partListing.title}</a>{' '}
          <span className="muted">({line.partListing.source})</span>
        </div>
      ) : (
        <div className="muted">Estimated price: no listing found for this vehicle</div>
      )}
      {alternatives.length > 0 && (
        <details>
          <summary>{alternatives.length} other {alternatives.length === 1 ? 'listing' : 'listings'}</summary>
          <ListingLinks listings={alternatives} />
        </details>
      )}
      {similar.length > 0 && (
        <div>
          Same part for other vehicles, for reference:
          <ListingLinks listings={similar} />
        </div>
      )}
      {searchLinks.length > 0 && (
        <div>
          Check on:{' '}
          {searchLinks.map((link, i) => (
            <span key={link.url}>
              {i > 0 && ', '}
              <a href={link.url} target="_blank" rel="noreferrer">{link.source}</a>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function CostTable({ cost }: { cost: CostEstimate }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Repair cost estimate</h2>
        <span className="total num">{money(cost.total)}</span>
      </div>
      {cost.lines.length === 0 ? (
        <p className="muted">No repairs required.</p>
      ) : (
        <div className="table-scroll">
          <table className="table cost-table">
            <thead>
              <tr>
                <th>Part</th>
                <th>Damage</th>
                <th>Operation</th>
                <th className="r">Parts</th>
                <th className="r">Paint</th>
                <th className="r">Labour hrs</th>
                <th className="r">Rate</th>
                <th className="r">Labour</th>
                <th className="r">Line total</th>
              </tr>
            </thead>
            <tbody>
              {cost.lines.map((l) => (
                <tr key={l.damageId}>
                  <td>
                    {l.part}
                    <PartSource line={l} />
                  </td>
                  <td>{l.type} <span className="muted">({l.severity})</span></td>
                  <td>{l.operation}</td>
                  <td className="r num">{money(l.parts)}</td>
                  <td className="r num">{money(l.paint)}</td>
                  <td className="r num">{l.laborHours.toFixed(1)}</td>
                  <td className="r num">{money(l.laborRate)}</td>
                  <td className="r num">{money(l.labor)}</td>
                  <td className="r num"><strong>{money(l.total)}</strong></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={3}>Total</th>
                <td className="r num">{money(cost.partsTotal)}</td>
                <td className="r num">{money(cost.paintTotal)}</td>
                <td className="r num">{cost.laborHours.toFixed(1)}</td>
                <td />
                <td className="r num">{money(cost.laborTotal)}</td>
                <td className="r num"><strong>{money(cost.total)}</strong></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="muted small">
        Parts are charged only when an item is replaced, once per part. Where RockAuto lists the part for this vehicle,
        the cheapest listing is used and linked; check its fitment note (trim, body style) before relying on it. Otherwise
        the part price is an estimate from a fixed table at the {cost.makeTier} make tier
        (×{cost.tierMultiplier.toFixed(1)}). Labour ({money(cost.laborRate)} per hour) and paint are placeholder rates.
        Prices exclude shipping and tax.
      </p>
    </section>
  );
}

export function FraudPanel({ fraud }: { fraud: FraudAssessment }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Fraud risk</h2>
        <span className="score-pair">
          <span className="num"><strong>{fraud.score}</strong> / 100</span>
          <Badge tone={levelTone(fraud.band)}>{fraud.band}</Badge>
        </span>
      </div>
      {fraud.signals.length === 0 ? (
        <p className="muted">No fraud indicators found.</p>
      ) : (
        <ul className="signals">
          {fraud.signals.map((s) => (
            <li key={s.kind}>
              <div>
                <strong>{s.label}</strong>
                <div className="muted small">{s.detail}</div>
              </div>
              <span className="num signal-points">+{s.points}</span>
            </li>
          ))}
        </ul>
      )}
      {fraud.notes.map((n) => <p key={n} className="muted small">{n}</p>)}
    </section>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={ok ? 'check-ok' : 'check-missing'}>
      <span aria-hidden="true">{ok ? '✓' : '✕'}</span>
      <span>{label}</span>
      {!ok && <span className="check-note">Not inspected</span>}
    </li>
  );
}

export function CoverageChecklist({ coverage }: { coverage: Coverage }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Coverage</h2>
        <Badge tone={coverage.complete ? 'good' : 'bad'}>{coverage.complete ? 'Complete' : 'Incomplete'}</Badge>
      </div>
      <h3>Views</h3>
      <ul className="checks">
        <Check ok={coverage.angles.front} label="Front" />
        <Check ok={coverage.angles.side} label="Side" />
        <Check ok={coverage.angles.rear} label="Rear" />
      </ul>
      <h3>Parts</h3>
      <ul className="checks">
        {PARTS.map((part) => <Check key={part} ok={coverage.parts[part]} label={part} />)}
      </ul>
    </section>
  );
}
