import { QUALITY_MESSAGES, type QualityResult } from '@claimlens/shared';
import { Badge } from './Badge';

export interface PhotoItem {
  key: string;
  file: File;
  previewUrl: string;
  quality: QualityResult | null;
  error: string | null;
}

export function PhotoCard({ item, onRemove }: { item: PhotoItem; onRemove(): void }) {
  const { quality, error, file } = item;
  return (
    <li className="photo-card">
      <img src={item.previewUrl} alt="" />
      <div className="photo-card-body">
        <span className="photo-card-name" title={file.name}>{file.name}</span>
        {error ? (
          <Badge tone="bad">Fail: {error}</Badge>
        ) : !quality ? (
          <Badge tone="neutral">Checking…</Badge>
        ) : quality.pass ? (
          <Badge tone="good">Pass</Badge>
        ) : (
          <Badge tone="bad">Fail: {quality.issues.map((i) => QUALITY_MESSAGES[i]).join(', ')}</Badge>
        )}
        {quality && (
          <span className="muted small">
            {quality.width} × {quality.height}
          </span>
        )}
      </div>
      <button type="button" className="photo-card-remove" onClick={onRemove} aria-label={`Remove ${file.name}`}>
        ×
      </button>
    </li>
  );
}
