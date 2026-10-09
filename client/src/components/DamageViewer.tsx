import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { QUALITY_MESSAGES, type PhotoRecord, type Severity } from '@claimlens/shared';
import { hitTest, toPixels } from '../lib/boxes';
import { Badge, levelTone } from './Badge';

export interface ActiveDamage { photoId: string; index: number }

interface Props {
  photos: PhotoRecord[];
  selectedPhotoId: string;
  onSelectPhoto(id: string): void;
  active: ActiveDamage | null;
  onActive(damage: ActiveDamage | null): void;
}

// Status palette; the same steps are used on light and dark surfaces.
export const SEVERITY_COLOR: Record<Severity, string> = { Low: '#0ca30c', Medium: '#fab219', High: '#d03b3b' };

export function DamageViewer({ photos, selectedPhotoId, onSelectPhoto, active, onActive }: Props) {
  const photo = photos.find((p) => p.id === selectedPhotoId) ?? photos[0];
  const img = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  // Hover highlights a box; a click pins it so the highlight survives the pointer leaving (and works on touch).
  const [pinned, setPinned] = useState<number | null>(null);
  const rows = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => setPinned(null), [photo.id]);

  const hoverIndex = active && active.photoId === photo.id ? active.index : null;
  const activeIndex = hoverIndex ?? pinned;

  const togglePin = (index: number) => {
    setPinned((current) => (current === index ? null : index));
    rows.current[index]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  useEffect(() => {
    const el = img.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [photo.id]);

  const boxes = useMemo(
    () => photo.damages.map((d, i) => ({ id: String(i), rect: toPixels(d.bbox, size.w, size.h) })),
    [photo, size],
  );

  useEffect(() => {
    const el = canvas.current;
    if (!el || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(size.w * dpr);
    el.height = Math.round(size.h * dpr);
    const ctx = el.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    photo.damages.forEach((damage, i) => {
      const { x, y, w, h } = boxes[i].rect;
      const color = SEVERITY_COLOR[damage.severity];
      const isActive = i === activeIndex;
      ctx.globalAlpha = isActive ? 0.3 : 0.12;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      // A dark under-stroke keeps the box visible on bright paintwork.
      ctx.lineWidth = isActive ? 5 : 4;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.strokeRect(x, y, w, h);
      ctx.lineWidth = isActive ? 3 : 2;
      ctx.strokeStyle = color;
      ctx.strokeRect(x, y, w, h);

      const label = `${i + 1}  ${damage.part} · ${damage.type}`;
      const chipW = ctx.measureText(label).width + 12;
      const chipH = 20;
      const chipX = Math.max(0, Math.min(x, size.w - chipW));
      const chipY = y - chipH - 2 >= 0 ? y - chipH - 2 : Math.min(y + 2, size.h - chipH);
      ctx.fillStyle = 'rgba(17, 19, 24, 0.88)';
      ctx.fillRect(chipX, chipY, chipW, chipH);
      ctx.fillStyle = color;
      ctx.fillRect(chipX, chipY, 3, chipH);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, chipX + 8, chipY + chipH / 2 + 0.5);
    });
  }, [photo, boxes, size, activeIndex]);

  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const bounds = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - bounds.left;
    const y = e.clientY - bounds.top;
    const hit = hitTest(boxes, x, y);
    setPointer(hit === null ? null : { x, y });
    const index = hit === null ? null : Number(hit);
    if (index !== hoverIndex) onActive(index === null ? null : { photoId: photo.id, index });
  };

  const onCanvasClick = (e: PointerEvent<HTMLCanvasElement>) => {
    const bounds = e.currentTarget.getBoundingClientRect();
    const hit = hitTest(boxes, e.clientX - bounds.left, e.clientY - bounds.top);
    if (hit === null) setPinned(null);
    else togglePin(Number(hit));
  };

  const tip = pointer && hoverIndex !== null ? photo.damages[hoverIndex] : null;

  return (
    <section className="card viewer">
      <ul className="thumbs" aria-label="Photos">
        {photos.map((p, i) => (
          <li key={p.id}>
            <button
              type="button"
              className={`thumb${p.id === photo.id ? ' thumb-selected' : ''}`}
              onClick={() => { onActive(null); onSelectPhoto(p.id); }}
              aria-pressed={p.id === photo.id}
              aria-label={`Photo ${i + 1}, ${p.quality.pass ? `${p.damages.length} damaged regions` : 'failed quality check'}`}
            >
              <img src={p.url} alt="" />
              <span className={`thumb-count${!p.quality.pass ? ' thumb-fail' : ''}`}>
                {p.quality.pass ? p.damages.length : 'Fail'}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="viewer-stage-wrap">
        <div className="viewer-stage">
          <img
            ref={img}
            src={photo.url}
            width={photo.width}
            height={photo.height}
            alt={`Vehicle photo${photo.angle ? `, ${photo.angle} view` : ''}`}
          />
          <canvas
            ref={canvas}
            style={{ cursor: hoverIndex !== null && pointer ? 'pointer' : 'default' }}
            onPointerMove={onMove}
            onPointerUp={onCanvasClick}
            onPointerLeave={() => { setPointer(null); onActive(null); }}
            aria-hidden="true"
          />
          {tip && pointer && (
            <div
              className="viewer-tip"
              style={{
                left: Math.min(pointer.x + 14, Math.max(0, size.w - 230)),
                top: Math.min(pointer.y + 14, Math.max(0, size.h - 90)),
              }}
            >
              <strong>{tip.part} · {tip.type}</strong>
              <span>{tip.severity} severity, {Math.round(tip.confidence * 100)}% confidence</span>
              {tip.note && <span className="viewer-tip-note">{tip.note}</span>}
            </div>
          )}
        </div>
      </div>

      <div className="viewer-meta muted small">
        <span>{photo.filename}</span>
        {photo.angle && <span>View: {photo.angle}</span>}
        <span>{photo.quality.width} × {photo.quality.height}</span>
      </div>

      {!photo.quality.pass ? (
        <p className="muted">
          Not analysed: {photo.quality.issues.map((i) => QUALITY_MESSAGES[i]).join(', ').toLowerCase()}.
        </p>
      ) : photo.damages.length === 0 ? (
        <p className="muted">No damage detected in this photo.</p>
      ) : (
        <ol className="damage-list">
          {photo.damages.map((d, i) => (
            <li
              key={i}
              ref={(el) => { rows.current[i] = el; }}
              tabIndex={0}
              role="button"
              aria-pressed={i === pinned}
              className={`${i === activeIndex ? 'damage-active' : ''}${i === pinned ? ' damage-pinned' : ''}`}
              onClick={() => togglePin(i)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePin(i); }
              }}
              onMouseEnter={() => onActive({ photoId: photo.id, index: i })}
              onMouseLeave={() => onActive(null)}
              onFocus={() => onActive({ photoId: photo.id, index: i })}
              onBlur={() => onActive(null)}
            >
              <span className="damage-num">{i + 1}</span>
              <span className="damage-main">
                <strong>{d.part}</strong> · {d.type}
                {d.note && <span className="muted small damage-note">{d.note}</span>}
              </span>
              <Badge tone={levelTone(d.severity)}>{d.severity}</Badge>
              <span className="muted small num">{Math.round(d.confidence * 100)}%</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
