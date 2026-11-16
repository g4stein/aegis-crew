import type { ReactNode } from 'react';

/** Mechanical button: 1px rule, invert on hover, 1px press offset, no easing. */
export function Button({ onClick, disabled = false, children }: { onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" className="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
