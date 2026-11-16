// Ingest pipeline (Requirement 3). Pure: parsed AST + metadata in, file contents out.
// The CLI adapter does the parsing, hashing, and writing.
import type { SourceUnit } from '@solidity-parser/parser/dist/src/ast-types';
import { toAstMap } from './ast-map';
import { canonicalJson } from './canonical-json';
import { proposeInvariants } from './invariants';
import { renderPlan } from './plan';
import { err, ok, type Result } from './result';
import type { AstMap, ProposedInvariant } from './types';

export interface IngestMeta {
  /** File name as given, e.g. "legacy-vault.sol". */
  readonly sourceName: string;
  /** Lowercase hex SHA-256 of the source bytes. */
  readonly sha256: string;
}

export interface IngestResult {
  /** Kebab-case base name: `<name>.ast.json`, `.kiro/specs/<name>-modernization/`. */
  readonly name: string;
  readonly map: AstMap;
  readonly invariants: readonly ProposedInvariant[];
  readonly astJson: string;
  readonly invariantsJson: string;
  readonly specFiles: { readonly 'requirements.md': string; readonly 'design.md': string; readonly 'tasks.md': string };
}

/** "LegacyVault.sol" -> "legacy-vault", "legacy_vault v2.sol" -> "legacy-vault-v2". */
export function specName(sourceName: string): string {
  const base = sourceName.replace(/^.*[\\/]/, '').replace(/\.sol$/i, '');
  return base
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildIngest(unit: SourceUnit, meta: IngestMeta): Result<IngestResult, string> {
  const name = specName(meta.sourceName);
  if (name === '') return err(`cannot derive a spec name from "${meta.sourceName}"`);
  if (!/^[0-9a-f]{64}$/.test(meta.sha256)) return err('sha256 must be 64 lowercase hex characters');

  const map = toAstMap(unit, meta);
  const invariants = proposeInvariants(map);
  const plan = renderPlan(map, invariants);
  if (!plan.ok) return plan;

  return ok({
    name,
    map,
    invariants,
    astJson: canonicalJson(map),
    // Same entry format as aegis-sentinel/config/guarded.json `invariants` (design.md).
    invariantsJson: canonicalJson({ source: map.source, invariants }),
    specFiles: {
      'requirements.md': plan.value.requirementsMd,
      'design.md': plan.value.designMd,
      'tasks.md': plan.value.tasksMd,
    },
  });
}
