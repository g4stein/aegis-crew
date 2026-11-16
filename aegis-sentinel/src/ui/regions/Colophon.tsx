import { Cell } from '../primitives/Sheet';
import { Label } from '../primitives/Type';

export function Colophon() {
  return (
    <Cell span={12} as="footer" pad="none">
      <div className="colophon">
        <div>
          <Label tone="ash">Set in</Label>
          <div>JetBrains Mono &amp; Playfair Display</div>
        </div>
        <div>
          <Label tone="ash">Spec</Label>
          <div>.kiro/specs/aegis-protocol</div>
        </div>
        <div>
          <Label tone="ash">Edition</Label>
          <div>AEGIS CREW · Kiroween 2026 · Frankenstein</div>
        </div>
      </div>
    </Cell>
  );
}
