import type { CSSProperties } from 'react';

/** Stepped segment meter. Fills whole segments only; no animation. */
export function Meter({ value, max, segments = 20, critical = false, label }: { value: number; max: number; segments?: number; critical?: boolean; label: string }) {
  const clamped = Math.max(0, Math.min(value, max));
  const on = Math.ceil((clamped / max) * segments);
  return (
    <div>
      <div
        className="meter"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={clamped}
        data-critical={critical || undefined}
        style={{ '--segments': segments } as CSSProperties}
      >
        {Array.from({ length: segments }, (_, i) => (
          <span key={i} data-on={i < on || undefined} />
        ))}
      </div>
      <div className="meter-scale" aria-hidden="true">
        <span>0</span>
        <span>{Math.round(max / 2)}</span>
        <span>{max} ms</span>
      </div>
    </div>
  );
}
