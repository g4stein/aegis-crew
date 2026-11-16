import type { ReactNode } from 'react';

/** Uppercase mono label. `ash` tone is for secondary text and renders at 14px. */
export function Label({ children, tone = 'default', id }: { children: ReactNode; tone?: 'default' | 'ash'; id?: string }) {
  return (
    <span className="label" data-tone={tone} id={id}>
      {children}
    </span>
  );
}

type HeadingSize = 'masthead' | 'headline' | 'section';

/** Playfair Display heading. `level` sets the outline; `size` sets the scale. */
export function Heading({ level, size, id, children }: { level: 1 | 2 | 3; size: HeadingSize; id?: string; children: ReactNode }) {
  const Tag = `h${level}` as const;
  return (
    <Tag className={`heading-${size}`} id={id}>
      {children}
    </Tag>
  );
}

/** Section header row: serif title on the left, mono meta on the right. */
export function SectionHead({ id, title, meta }: { id: string; title: string; meta?: ReactNode }) {
  return (
    <header className="section-head">
      <Heading level={2} size="section" id={id}>
        {title}
      </Heading>
      {meta !== undefined && <Label>{meta}</Label>}
    </header>
  );
}
