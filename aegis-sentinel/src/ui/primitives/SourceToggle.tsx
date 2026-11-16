import { useRef, type KeyboardEvent } from 'react';
import { Mark } from './Glyph';

export interface ToggleOption<T extends string> {
  readonly id: T;
  readonly label: string;
}

/**
 * Two-way switch rendered as a ruled grid of radio buttons. The selected option is inverted.
 * Arrow keys move the selection (WAI-ARIA radio group pattern); changes are instant.
 */
export function SourceToggle<T extends string>({ label, options, value, onChange }: { label: string; options: readonly ToggleOption<T>[]; value: T; onChange: (id: T) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, options.findIndex((o) => o.id === value));

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const next = (index + delta + options.length) % options.length;
    onChange(options[next]!.id);
    refs.current[next]?.focus();
  };

  return (
    <div className="toggle" role="radiogroup" aria-label={label} onKeyDown={onKey} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o, i) => (
        <button
          key={o.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          tabIndex={o.id === value ? 0 : -1}
          className="toggle-option"
          onClick={() => onChange(o.id)}
        >
          <Mark shape={o.id === value ? 'square-filled' : 'square'} /> {o.label}
        </button>
      ))}
    </div>
  );
}
