import { useRef, useState, type DragEvent } from 'react';

const ACCEPT = ['image/jpeg', 'image/png', 'image/webp'];

interface Props {
  onFiles(files: File[]): void;
  disabled?: boolean;
  compact?: boolean;
  label?: string;
}

export function DropZone({ onFiles, disabled, compact, label = 'Drag and drop photos here' }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [ignored, setIgnored] = useState<string[]>([]);

  const take = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    const good = files.filter((f) => ACCEPT.includes(f.type));
    setIgnored(files.filter((f) => !ACCEPT.includes(f.type)).map((f) => f.name));
    if (good.length) onFiles(good);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!disabled) take(e.dataTransfer.files);
  };

  return (
    <div>
      <div
        className={`dropzone${over ? ' dropzone-over' : ''}${compact ? ' dropzone-compact' : ''}`}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={() => !disabled && input.current?.click()}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            input.current?.click();
          }
        }}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <strong>{label}</strong>
        <span className="muted">or click to browse. JPEG, PNG or WebP, up to 15 MB each.</span>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={ACCEPT.join(',')}
          onChange={(e) => { take(e.target.files); e.target.value = ''; }}
        />
      </div>
      {ignored.length > 0 && (
        <p className="inline-error" role="alert">
          Skipped (not a JPEG, PNG or WebP image): {ignored.join(', ')}
        </p>
      )}
    </div>
  );
}
