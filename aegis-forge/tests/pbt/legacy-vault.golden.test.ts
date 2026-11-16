// Golden check: the committed Forge output for input/legacy-vault.sol must be exactly what the
// pipeline produces today. Keeps the CLI (not hand edits) the source of truth (3.1, 3.5, 3.13).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSolidity } from '../../src/adapters/solidity-parser';
import { buildIngest } from '../../src/logic/ingest';

const root = new URL('../../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

describe('golden: aegis-forge/input/legacy-vault.sol', () => {
  const bytes = readFileSync(new URL('aegis-forge/input/legacy-vault.sol', root));
  const unit = parseSolidity(bytes.toString('utf8'));
  if (!unit.ok) throw new Error(JSON.stringify(unit.error));
  const result = buildIngest(unit.value, { sourceName: 'legacy-vault.sol', sha256: createHash('sha256').update(bytes).digest('hex') });
  if (!result.ok) throw new Error(result.error);
  const r = result.value;

  it('committed outputs are byte-identical to a fresh ingest', () => {
    expect(read('aegis-forge/output/legacy-vault.ast.json')).toBe(r.astJson);
    expect(read('aegis-forge/output/legacy-vault.invariants.json')).toBe(r.invariantsJson);
    for (const [file, content] of Object.entries(r.specFiles)) {
      expect(read(`.kiro/specs/legacy-vault-modernization/${file}`)).toBe(content);
    }
  });

  it('detects every planted legacy risk (3.7)', () => {
    const at = (id: string) => r.map.risks.filter((x) => x.id === id).map((x) => `${x.contract}.${x.function ?? ''}`);
    expect(at('legacy-pragma')).toEqual(['SafeMath.', 'ERC20.', 'LegacyVault.']);
    expect(at('tx-origin-auth')).toEqual(['LegacyVault.onlyOwner']);
    expect(at('unchecked-call')).toEqual(['LegacyVault.sweepProtocolFees']);
    expect(at('call-before-write')).toEqual([
      'LegacyVault.deposit',
      'LegacyVault.withdraw',
      'LegacyVault.swapEthForTokens',
      'LegacyVault.sweepProtocolFees',
    ]);
  });

  it('proposes the balance invariant for the share token (3.8)', () => {
    expect(r.invariants).toEqual([{ id: 'balance-conservation', kind: 'balance-conservation', contract: 'LegacyVault', balances: 'balanceOf', supply: 'totalSupply' }]);
  });
});
