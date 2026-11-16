import type { CSSProperties, ElementType, ReactNode } from 'react';

type Span = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/** The page grid: 12 columns, collapsed 1px rules, gap 0. */
export function Sheet({ children }: { children: ReactNode }) {
  return <main className="sheet">{children}</main>;
}

interface CellProps {
  span?: Span;
  as?: ElementType;
  pad?: 'default' | 'none';
  fill?: 'obsidian' | 'graphite';
  className?: string;
  labelledBy?: string;
  children: ReactNode;
}

/** One grid cell. Draws its own right and bottom rules. */
export function Cell({ span = 12, as: Tag = 'section', pad = 'default', fill = 'obsidian', className, labelledBy, children }: CellProps) {
  return (
    <Tag
      className={className ? `cell ${className}` : 'cell'}
      style={{ '--span': span } as CSSProperties}
      data-pad={pad}
      data-fill={fill}
      aria-labelledby={labelledBy}
    >
      {children}
    </Tag>
  );
}

/** A nested grid inside a cell, with collapsed rules. */
export function Subgrid({ cols, children }: { cols: number; children: ReactNode }) {
  return (
    <div className="subgrid" style={{ '--cols': cols } as CSSProperties}>
      {children}
    </div>
  );
}
