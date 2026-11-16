import type { ReactElement } from 'react';

// Status glyphs. No icon libraries (ui-manifesto.md: Icons).
// Shapes are hand-drawn inline SVG from straight strokes with square caps, so they render
// the same everywhere regardless of font coverage. Bracket marks stay typographic.

export type Shape = 'square' | 'square-filled' | 'arrow-right' | 'arrow-left' | 'cross' | 'triangle';

const PATHS: Record<Shape, ReactElement> = {
  square: <rect x="2" y="2" width="8" height="8" fill="none" />,
  'square-filled': <rect x="1.5" y="1.5" width="9" height="9" fill="currentColor" stroke="none" />,
  'arrow-right': <path d="M1 6H10M6.5 2.5L10 6L6.5 9.5" fill="none" />,
  'arrow-left': <path d="M11 6H2M5.5 2.5L2 6L5.5 9.5" fill="none" />,
  cross: <path d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5" fill="none" />,
  triangle: <path d="M6 1.5L10.5 10.5H1.5Z" fill="currentColor" stroke="none" />,
};

/** A single straight-stroke SVG mark, sized to the surrounding text. Decorative by default. */
export function Mark({ shape }: { shape: Shape }) {
  return (
    <svg className="mark" viewBox="0 0 12 12" aria-hidden="true" focusable="false" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter">
      {PATHS[shape]}
    </svg>
  );
}

export type GlyphKind = 'holding' | 'breach' | 'contained' | 'pending' | 'done' | 'current' | 'failed' | 'info' | 'warn' | 'critical';

const GLYPHS: Record<GlyphKind, { mark: Shape | string; text: string }> = {
  holding: { mark: 'square', text: 'HOLDING' },
  breach: { mark: '[!]', text: 'BREACH' },
  contained: { mark: 'square-filled', text: 'CONTAINED' },
  pending: { mark: 'square', text: 'PENDING' },
  done: { mark: 'square-filled', text: 'DONE' },
  current: { mark: 'arrow-right', text: 'IN FLIGHT' },
  failed: { mark: 'cross', text: 'FAILED' },
  info: { mark: '[OK]', text: 'INFO' },
  warn: { mark: 'triangle', text: 'WARN' },
  critical: { mark: '[!]', text: 'CRIT' },
};

function renderMark(mark: Shape | string) {
  return mark in PATHS ? <Mark shape={mark as Shape} /> : <span aria-hidden="true">{mark}</span>;
}

/** Mark plus text label, so color is never the only signal. `markOnly` keeps the text for screen readers. */
export function Glyph({ kind, markOnly = false }: { kind: GlyphKind; markOnly?: boolean }) {
  const g = GLYPHS[kind];
  return (
    <span className="glyph">
      {renderMark(g.mark)}
      {markOnly ? <span className="visually-hidden">{g.text}</span> : <> {g.text}</>}
    </span>
  );
}
