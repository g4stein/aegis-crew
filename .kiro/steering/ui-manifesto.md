---
inclusion: fileMatch
fileMatchPattern: ["aegis-sentinel/src/ui/**", "aegis-sentinel/**/*.tsx", "aegis-sentinel/**/*.css", "aegis-sentinel/index.html"]
---

# UI Manifesto: Editorial Brutalism

The Sentinel reads like a printed security bulletin: a rigid grid, heavy type contrast, and no decoration. Every pixel either carries data or separates data.

## Forbidden

Code that contains any of the following is rejected in review and flagged by the spec-audit hook.

| Forbidden | Detection hint |
|---|---|
| Glassmorphism | `backdrop-filter`, `backdrop-blur`, translucent `rgba(...)` panel backgrounds |
| Gradients of any kind, especially purple/blue | `linear-gradient`, `radial-gradient`, `conic-gradient`, `bg-gradient-*` |
| Soft shadows | `box-shadow` with blur > 0, `drop-shadow`, `shadow-*` utilities |
| Rounded corners | `border-radius` > 0, `rounded-*` utilities |
| Default Inter or system sans | `Inter`, `system-ui`, `-apple-system`, `Roboto`, `Helvetica`, `Arial` |
| Generic icon packs | `lucide-react`, `react-icons`, `heroicons`, `@phosphor-icons` |
| Generic bento grids | Uneven rounded cards floating in whitespace, `gap` without visible borders |
| Bouncy or eased motion | `cubic-bezier` with overshoot, `ease-in-out`, spring physics, `framer-motion` springs |
| Acid Green used decoratively | `#CCFF00` on anything that is not a critical alert |

## Required

### Color tokens

Use only these tokens. No other hex values appear in components.

```css
:root {
  --obsidian:   #0A0A0A; /* page background */
  --off-white:  #F0F0F0; /* text, borders, rules */
  --graphite:   #1A1A1A; /* alternate row / inactive cell fill */
  --ash:        #8A8A8A; /* secondary text, disabled state */
  --acid:       #CCFF00; /* CRITICAL ALERTS ONLY */
}
```

`--acid` is reserved for one meaning: an invariant is breached or a mitigation is in flight. If nothing is critical, no acid green is on screen.

### Typography

| Role | Family | Usage |
|---|---|---|
| Data | `"JetBrains Mono", ui-monospace, monospace` | Numbers, hashes, addresses, logs, tables, labels, buttons |
| Headings | `"Playfair Display", "Times New Roman", serif` | Page titles, section headings, alert headlines |

- Self-host both fonts (`@fontsource/jetbrains-mono`, `@fontsource/playfair-display`). No runtime Google Fonts request.
- Numeric data uses `font-variant-numeric: tabular-nums`.
- Labels are uppercase mono with `letter-spacing: 0.08em`.
- Headings are large and tight: `line-height: 1.0` to `1.1`.

### Layout

- Every layout is a CSS Grid with explicit `grid-template-columns` and `grid-template-rows`. No ad-hoc flex stacks for page structure.
- Cells are separated by visible `1px solid var(--off-white)` borders. Use collapsed borders (border on right and bottom of each cell, plus top and left on the container) so lines never double up.
- `gap: 0`. Spacing comes from cell padding on a 4px base (4, 8, 16, 24, 32).
- `border-radius: 0` everywhere.

### Icons

No icon libraries. Use typographic glyphs or ASCII: `■ □ ▲ ▼ ● ○ → ← ✕ [!] [OK] [ERR]`. A custom glyph is a hand-drawn inline SVG built from straight strokes with `stroke-linecap: square`.

### Motion and interaction

Interactions feel mechanical and instant, like a relay switching.

- State changes are instant (`transition: none`) or at most `80ms` with `linear` or `steps(n)` timing.
- Hover: invert the colors (off-white fill, obsidian text). No scale, lift, or glow.
- Active/pressed: 1px inset offset (`transform: translate(1px, 1px)`), no easing.
- Focus: `outline: 2px solid var(--off-white); outline-offset: 2px`. Never remove focus outlines.
- Critical alert: the alert cell switches to `--acid` background with obsidian text. Optional blink uses `steps(1)` at 1Hz and stops under `prefers-reduced-motion: reduce`.

## Accessibility

- Off-white on obsidian and obsidian on acid both exceed WCAG AA contrast. `--ash` is for secondary text at 14px or larger only.
- Color is never the only signal. A critical alert also carries a text label (`[!] BREACH`) and an ARIA live region (`role="alert"`).
- All interactive elements are reachable by keyboard.

## Review checklist

- [ ] Only the five color tokens are used.
- [ ] Mono for data, serif for headings; no Inter or system sans.
- [ ] CSS Grid with visible 1px borders, `gap: 0`, `border-radius: 0`.
- [ ] No gradients, blur, shadows, or icon libraries.
- [ ] Motion is instant or ≤80ms linear/steps.
- [ ] Acid green appears only for a critical state.
